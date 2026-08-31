//! Session-tree projection over harness-native JSONL.
//!
//! Sessions are append-only trees: every entry carries an `id` and a
//! `parentId`, and branching adds a second child to an earlier entry rather
//! than a second file. That tree is the reason to use pi/omp over a
//! fork-per-branch harness, but only pi exposes `get_tree` over RPC, and only
//! while a runtime is live. Reading the file instead covers both harnesses,
//! live or dead sessions, local or remote — one implementation, one shape.
//!
//! The output is a **flat** node list, not a nested one. `parentId` is already
//! on every node, the desktop bridge extension emits the same flat shape, and
//! one nesting pass in the UI serves both sources.
//!
//! Read-only, like the rest of the session catalog: the harness owns its files.

use std::path::Path;

use serde::Serialize;

use crate::error::Result;
use crate::sessions::{read_capped, split_lines};

/// Per-file scan cap, matching the catalog's. Larger files are read up to the
/// cap and flagged, never rejected.
const DEFAULT_FILE_CAP: u64 = 8 * 1024 * 1024;
/// Previews are for orientation in a tree row, not for reading.
const PREVIEW_CHARS: usize = 140;

/// One entry, projected for display. Field names and semantics match
/// `src-tauri/resources/pi-desktop-bridge.ts` so the UI has a single node type.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    pub parent_id: Option<String>,
    /// Raw entry type: message | compaction | branch_summary | model_change |
    /// thinking_level_change | custom | custom_message | label | session_info.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// For `message` entries: user | assistant | toolResult | bashExecution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_id: Option<String>,
    /// Resolved from `label` entries targeting this node; latest wins.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTree {
    pub nodes: Vec<TreeNode>,
    /// Session header fields, so a tree can be previewed without a runtime.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Set when the session was forked from another file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session: Option<String>,
    /// The last appended entry. This is the leaf *only* until someone
    /// navigates: `SessionManager.branch()` moves the leaf in memory and writes
    /// nothing, so a live runtime's true leaf must come from the harness
    /// (`get_tree` on pi, `/pd-state` on either). Never treat this as
    /// authoritative while a runtime is attached.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_entry_id: Option<String>,
    pub truncated: bool,
}

pub fn read_tree(path: &Path) -> Result<SessionTree> {
    read_tree_capped(path, DEFAULT_FILE_CAP)
}

pub fn read_tree_capped(path: &Path, cap: u64) -> Result<SessionTree> {
    let bytes = match read_capped(path, cap) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionTree {
                nodes: Vec::new(),
                session_id: None,
                cwd: None,
                name: None,
                parent_session: None,
                last_entry_id: None,
                truncated: false,
            })
        }
        Err(e) => return Err(e.into()),
    };
    let truncated = bytes.len() as u64 == cap;
    parse_tree(&bytes, truncated)
}

/// Parses session JSONL already in memory — the entry point for remote files,
/// which arrive over ssh rather than from the local filesystem.
pub fn read_tree_bytes(bytes: &[u8]) -> Result<SessionTree> {
    parse_tree(bytes, false)
}

fn parse_tree(bytes: &[u8], truncated: bool) -> Result<SessionTree> {
    let mut nodes: Vec<TreeNode> = Vec::new();
    let mut labels: Vec<(String, Option<String>)> = Vec::new();
    let mut tree = SessionTree {
        nodes: Vec::new(),
        session_id: None,
        cwd: None,
        name: None,
        parent_session: None,
        last_entry_id: None,
        truncated,
    };

    for line in split_lines(bytes) {
        // A truncated tail leaves a partial line; skip it rather than fail.
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) else { continue };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or_default();
        if kind == "session" {
            tree.session_id = str_field(&v, "id");
            tree.cwd = str_field(&v, "cwd");
            tree.parent_session = str_field(&v, "parentSession");
            continue;
        }
        if kind == "session_info" {
            if let Some(n) = str_field(&v, "name") {
                tree.name = Some(n); // latest wins
            }
        }
        // Labels are entries in their own right *and* annotations on a target.
        // Keep them as nodes (they occupy a slot in the chain) but resolve the
        // annotation onto the entry they point at.
        if kind == "label" {
            if let Some(target) = str_field(&v, "targetId") {
                labels.push((target, str_field(&v, "label")));
            }
        }
        let Some(id) = str_field(&v, "id") else { continue };
        nodes.push(project(id, kind, &v));
    }

    for (target, label) in labels {
        if let Some(node) = nodes.iter_mut().find(|n| n.id == target) {
            // A cleared label (`label` absent) resets the annotation.
            node.label = label;
        }
    }

    tree.last_entry_id = nodes.last().map(|n| n.id.clone());
    tree.nodes = nodes;
    Ok(tree)
}

fn project(id: String, kind: &str, v: &serde_json::Value) -> TreeNode {
    let mut node = TreeNode {
        id,
        parent_id: str_field(v, "parentId"),
        kind: kind.to_string(),
        timestamp: str_field(v, "timestamp"),
        role: None,
        preview: String::new(),
        tool_name: None,
        is_error: None,
        tool_calls: Vec::new(),
        model: None,
        provider: None,
        stop_reason: None,
        custom_type: None,
        from_id: None,
        label: None,
    };

    match kind {
        "message" => {
            let msg = v.get("message").cloned().unwrap_or(serde_json::Value::Null);
            node.role = str_field(&msg, "role");
            match node.role.as_deref() {
                Some("assistant") => {
                    let blocks = msg.get("content").and_then(|c| c.as_array());
                    node.preview = clip(&text_blocks(blocks));
                    node.tool_calls = blocks
                        .map(|bs| {
                            bs.iter()
                                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("toolCall"))
                                .filter_map(|b| str_field(b, "name"))
                                .collect()
                        })
                        .unwrap_or_default();
                    node.model = str_field(&msg, "model");
                    node.provider = str_field(&msg, "provider");
                    node.stop_reason = str_field(&msg, "stopReason");
                }
                Some("toolResult") => {
                    node.tool_name = str_field(&msg, "toolName");
                    node.is_error = msg.get("isError").and_then(|e| e.as_bool());
                    node.preview = clip(&text_blocks(msg.get("content").and_then(|c| c.as_array())));
                }
                Some("bashExecution") => {
                    node.tool_name = Some("bash".to_string());
                    node.preview = clip(&str_field(&msg, "command").unwrap_or_default());
                }
                _ => {
                    node.preview = clip(&content_text(msg.get("content")));
                }
            }
        }
        "compaction" | "branch_summary" => {
            node.preview = clip(&str_field(v, "summary").unwrap_or_default());
            node.from_id = str_field(v, "fromId");
        }
        "model_change" => {
            // pi splits provider/modelId; omp stores one `model` string.
            node.preview = match (str_field(v, "provider"), str_field(v, "modelId")) {
                (Some(p), Some(m)) => format!("{p}/{m}"),
                _ => str_field(v, "model").unwrap_or_default(),
            };
        }
        "thinking_level_change" => {
            node.preview = str_field(v, "thinkingLevel").unwrap_or_default();
        }
        "custom_message" => {
            node.custom_type = str_field(v, "customType");
            node.preview = clip(&content_text(v.get("content")));
        }
        "custom" => {
            node.custom_type = str_field(v, "customType");
        }
        "session_info" => {
            node.preview = clip(&str_field(v, "name").unwrap_or_default());
        }
        "label" => {
            node.from_id = str_field(v, "targetId");
            node.preview = clip(&str_field(v, "label").unwrap_or_default());
        }
        _ => {}
    }
    node
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
}

/// User content is `string | (TextContent | ImageContent)[]`.
fn content_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(a)) => text_blocks(Some(a)),
        _ => String::new(),
    }
}

fn text_blocks(blocks: Option<&Vec<serde_json::Value>>) -> String {
    let Some(blocks) = blocks else { return String::new() };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("")
}

/// Collapses whitespace and clips on a char boundary — previews are single-line.
fn clip(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= PREVIEW_CHARS {
        return flat;
    }
    let mut out: String = flat.chars().take(PREVIEW_CHARS).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_session(lines: &[&str]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        (dir, path)
    }

    #[test]
    fn projects_a_branching_pi_session() {
        let (_d, path) = write_session(&[
            r#"{"type":"session","version":3,"id":"019f","cwd":"/home/u/proj","timestamp":"2026-08-10T22:41:20.246Z"}"#,
            r#"{"type":"message","id":"a1","parentId":null,"timestamp":"t1","message":{"role":"user","content":"refactor auth"}}"#,
            r#"{"type":"message","id":"b2","parentId":"a1","timestamp":"t2","message":{"role":"assistant","provider":"anthropic","model":"claude-opus-4-8","stopReason":"toolUse","content":[{"type":"text","text":"On it."},{"type":"toolCall","id":"c1","name":"bash","arguments":{}}]}}"#,
            r#"{"type":"message","id":"c3","parentId":"b2","timestamp":"t3","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","isError":false,"content":[{"type":"text","text":"ok"}]}}"#,
            // A second child of a1: the branch.
            r#"{"type":"message","id":"d4","parentId":"a1","timestamp":"t4","message":{"role":"user","content":[{"type":"text","text":"actually, approach B"}]}}"#,
            r#"{"type":"label","id":"e5","parentId":"d4","timestamp":"t5","targetId":"d4","label":"approach-b"}"#,
        ]);
        let tree = read_tree(&path).unwrap();

        assert_eq!(tree.session_id.as_deref(), Some("019f"));
        assert_eq!(tree.cwd.as_deref(), Some("/home/u/proj"));
        assert_eq!(tree.nodes.len(), 5, "header is metadata, not a node");
        assert!(!tree.truncated);

        let a1 = &tree.nodes[0];
        assert_eq!(a1.parent_id, None);
        assert_eq!(a1.role.as_deref(), Some("user"));
        assert_eq!(a1.preview, "refactor auth", "string content");

        let b2 = &tree.nodes[1];
        assert_eq!(b2.preview, "On it.", "text blocks only; tool calls listed apart");
        assert_eq!(b2.tool_calls, vec!["bash"]);
        assert_eq!(b2.provider.as_deref(), Some("anthropic"));
        assert_eq!(b2.stop_reason.as_deref(), Some("toolUse"));

        let c3 = &tree.nodes[2];
        assert_eq!(c3.tool_name.as_deref(), Some("bash"));
        assert_eq!(c3.is_error, Some(false));

        let d4 = &tree.nodes[3];
        assert_eq!(d4.parent_id.as_deref(), Some("a1"), "sibling of b2 — the branch");
        assert_eq!(d4.preview, "actually, approach B", "array content");
        assert_eq!(d4.label.as_deref(), Some("approach-b"), "label resolved onto its target");

        // Two children of a1 is what makes this a tree rather than a list.
        let children: Vec<&str> =
            tree.nodes.iter().filter(|n| n.parent_id.as_deref() == Some("a1")).map(|n| n.id.as_str()).collect();
        assert_eq!(children, vec!["b2", "d4"]);
    }

    #[test]
    fn normalizes_model_change_across_both_harnesses() {
        let (_d, pi) = write_session(&[
            r#"{"type":"session","version":3,"id":"1"}"#,
            r#"{"type":"model_change","id":"m1","parentId":null,"provider":"anthropic","modelId":"claude-opus-4-8"}"#,
        ]);
        assert_eq!(read_tree(&pi).unwrap().nodes[0].preview, "anthropic/claude-opus-4-8");

        let (_d2, omp) = write_session(&[
            r#"{"type":"session","version":3,"id":"1"}"#,
            r#"{"type":"model_change","id":"m1","parentId":null,"model":"openrouter/z-ai/glm-5.3-flash"}"#,
        ]);
        assert_eq!(read_tree(&omp).unwrap().nodes[0].preview, "openrouter/z-ai/glm-5.3-flash");
    }

    #[test]
    fn last_entry_is_reported_but_is_not_the_live_leaf() {
        let (_d, path) = write_session(&[
            r#"{"type":"session","version":3,"id":"1","parentSession":"/prev/s.jsonl"}"#,
            r#"{"type":"message","id":"a1","parentId":null,"message":{"role":"user","content":"one"}}"#,
            r#"{"type":"message","id":"b2","parentId":"a1","message":{"role":"user","content":"two"}}"#,
        ]);
        let tree = read_tree(&path).unwrap();
        assert_eq!(tree.last_entry_id.as_deref(), Some("b2"));
        assert_eq!(tree.parent_session.as_deref(), Some("/prev/s.jsonl"));
    }

    #[test]
    fn clears_a_label_when_the_entry_omits_it() {
        let (_d, path) = write_session(&[
            r#"{"type":"session","version":3,"id":"1"}"#,
            r#"{"type":"message","id":"a1","parentId":null,"message":{"role":"user","content":"x"}}"#,
            r#"{"type":"label","id":"l1","parentId":"a1","targetId":"a1","label":"keep"}"#,
            r#"{"type":"label","id":"l2","parentId":"l1","targetId":"a1"}"#,
        ]);
        let tree = read_tree(&path).unwrap();
        assert_eq!(tree.nodes[0].label, None, "latest label entry wins, including a clear");
    }

    #[test]
    fn survives_partial_lines_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, r#"{{"type":"session","version":3,"id":"1"}}"#).unwrap();
        writeln!(f, r#"{{"type":"message","id":"a1","parentId":null,"message":{{"role":"user","content":"good"}}}}"#).unwrap();
        write!(f, r#"{{"type":"message","id":"a2","parentId":"a1","mess"#).unwrap();
        drop(f);
        let tree = read_tree(&path).unwrap();
        assert_eq!(tree.nodes.len(), 1, "a torn tail is skipped, not fatal");

        let missing = read_tree(&dir.path().join("nope.jsonl")).unwrap();
        assert!(missing.nodes.is_empty());
    }

    #[test]
    fn preview_clips_on_a_char_boundary() {
        let long = "é".repeat(400);
        let (_d, path) = write_session(&[
            r#"{"type":"session","version":3,"id":"1"}"#,
            &format!(
                r#"{{"type":"message","id":"a1","parentId":null,"message":{{"role":"user","content":"{long}"}}}}"#
            ),
        ]);
        let tree = read_tree(&path).unwrap();
        assert_eq!(tree.nodes[0].preview.chars().count(), PREVIEW_CHARS + 1, "clipped plus ellipsis");
    }
}
