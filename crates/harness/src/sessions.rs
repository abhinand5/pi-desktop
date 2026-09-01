//! Read-only catalog over harness-native session files (JSONL v3).
//!
//! Sessions are the harnesses' own files (CLI-compatible); the desktop never
//! writes them. Layout: `<agent_dir>/sessions/<bucket>/<ts>_<uuid>.jsonl`,
//! one bucket level deep, ordered by the ISO-timestamp filename prefix.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::Result;
use crate::harness::Harness;

/// Per-file scan cap; larger files are summarized with `truncated: true`.
const DEFAULT_FILE_CAP: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub path: PathBuf,
    pub id: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Normalized `provider/model-id` of the last model_change entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
    pub truncated: bool,
}

/// Scans one bucket level under the harness sessions root, newest first.
pub fn scan(harness: &dyn Harness) -> Result<Vec<SessionSummary>> {
    scan_root(&harness.sessions_root(), DEFAULT_FILE_CAP)
}

pub fn scan_root(root: &Path, file_cap: u64) -> Result<Vec<SessionSummary>> {
    let mut out = Vec::new();
    let mut buckets: Vec<PathBuf> = match std::fs::read_dir(root) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    buckets.sort();
    for bucket in buckets {
        let mut files: Vec<PathBuf> = match std::fs::read_dir(&bucket) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("jsonl"))
                .collect(),
            Err(_) => continue,
        };
        // Filename prefix is the ISO timestamp (dashes instead of colons) —
        // lexicographic ordering == chronological.
        files.sort();
        files.reverse();
        for file in files {
            if let Ok(Some(s)) = summarize(&file, file_cap) {
                out.push(s);
            }
        }
    }
    Ok(out)
}

/// Parses one session file. Returns `Ok(None)` when the file is not a v3
/// session (foreign/partial file) — never fatal for the catalog.
pub fn summarize(path: &Path, file_cap: u64) -> Result<Option<SessionSummary>> {
    let bytes = match read_capped(path, file_cap) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let truncated = bytes.len() as u64 == file_cap;

    // The header is the first parseable `{"type":"session",...}` line. omp
    // files may carry a fixed-width title slot line before it.
    let mut header: Option<serde_json::Value> = None;
    let mut entries_start = 0usize;
    for (idx, line) in split_lines(&bytes).enumerate() {
        if idx >= 4 && header.is_none() {
            break;
        }
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) {
            if v.get("type").and_then(|t| t.as_str()) == Some("session") {
                header = Some(v);
                entries_start = idx + 1;
                break;
            }
        }
    }
    let header = match header {
        Some(h) => h,
        None => return Ok(None),
    };
    if header.get("version").and_then(|v| v.as_u64()) != Some(3) {
        return Ok(None);
    }

    let mut name: Option<String> = None;
    let mut derived_name: Option<String> = None;
    let mut model: Option<String> = None;
    for line in split_lines(&bytes).skip(entries_start) {
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("message") => {
                if derived_name.is_none() {
                    derived_name = first_user_title(&v);
                }
            }
            Some("session_info") => {
                if let Some(n) = v.get("name").and_then(|n| n.as_str()) {
                    let trimmed = n.trim();
                    name = (!trimmed.is_empty()).then(|| trimmed.to_string());
                }
            }
            Some("model_change") => {
                if let Some(m) = normalize_model_change(&v) {
                    model = Some(m);
                }
            }
            _ => {}
        }
    }
    let name = name.or(derived_name);

    Ok(Some(SessionSummary {
        path: path.to_path_buf(),
        id: header.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        cwd: header.get("cwd").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        timestamp: header.get("timestamp").and_then(|v| v.as_str()).map(str::to_string),
        name,
        model,
        version: header.get("version").and_then(|v| v.as_u64()),
        truncated,
    }))
}

const SESSION_TITLE_CHARS: usize = 140;

fn first_user_title(entry: &serde_json::Value) -> Option<String> {
    let message = entry.get("message").or_else(|| entry.get("entry"))?;
    if message.get("role").and_then(|role| role.as_str()) != Some("user") {
        return None;
    }

    let content = match message.get("content") {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(|kind| kind.as_str()) == Some("text"))
            .filter_map(|block| block.get("text").and_then(|text| text.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    let line = content.lines().find(|line| !line.trim().is_empty())?;
    let flat = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= SESSION_TITLE_CHARS {
        return Some(flat);
    }
    Some(format!("{}…", flat.chars().take(SESSION_TITLE_CHARS).collect::<String>()))
}

/// pi stores split fields (`{"provider":..,"modelId":..}`); omp a single
/// `{"model":"provider/id"}` string. Normalizes to `provider/model-id`.
fn normalize_model_change(entry: &serde_json::Value) -> Option<String> {
    if let (Some(p), Some(m)) = (
        entry.get("provider").and_then(|v| v.as_str()),
        entry.get("modelId").and_then(|v| v.as_str()),
    ) {
        return Some(format!("{p}/{m}"));
    }
    entry.get("model").and_then(|v| v.as_str()).map(str::to_string)
}

pub(crate) fn read_capped(path: &Path, cap: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let f = std::fs::File::open(path)?;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let to_read = len.min(cap.saturating_add(1)) as usize;
    let mut buf = Vec::with_capacity(to_read.min(64 * 1024 * 1024));
    f.take(cap).read_to_end(&mut buf)?;
    Ok(buf)
}

pub(crate) fn split_lines(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.split(|&b| b == b'\n').filter(|l| !l.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::CommandSpec;
    use crate::{harness::CatalogOptions, spec::SpawnOptions};
    use std::io::Write;

    struct FakeHarness(PathBuf);
    impl Harness for FakeHarness {
        fn id(&self) -> crate::harness::HarnessId {
            crate::harness::HarnessId::Pi
        }
        fn spawn_spec(&self, _o: &SpawnOptions) -> CommandSpec {
            unreachable!()
        }
        fn translate_command(&self, _: &mut serde_json::Value) {}
        fn normalize_event(&self, _: &mut serde_json::Value) -> crate::harness::EventAction {
            crate::harness::EventAction::Pass
        }
        fn agent_dir(&self) -> PathBuf {
            self.0.clone()
        }
        fn catalog_kind(&self) -> crate::harness::CatalogKind {
            crate::harness::CatalogKind::RpcProbe
        }
        fn catalog_spec(&self, _: &CatalogOptions) -> CommandSpec {
            unreachable!()
        }
    }

    fn write(path: &Path, lines: &[&str]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    #[test]
    fn parses_pi_shape_with_split_model_fields() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions").join("--home-u-proj--");
        write(
            &root.join("2026-08-10T22-41-20-246Z_019f.jsonl"),
            &[
                r#"{"type":"session","version":3,"id":"019f","timestamp":"2026-08-10T22:41:20.246Z","cwd":"/home/u/proj"}"#,
                r#"{"type":"message","entry":{"role":"user"}}"#,
                r#"{"type":"model_change","provider":"anthropic","modelId":"claude-opus-4-8"}"#,
                r#"{"type":"session_info","name":"fix the build"}"#,
            ],
        );
        let s = summarize(&root.join("2026-08-10T22-41-20-246Z_019f.jsonl"), DEFAULT_FILE_CAP)
            .unwrap()
            .unwrap();
        assert_eq!(s.id, "019f");
        assert_eq!(s.cwd, "/home/u/proj");
        assert_eq!(s.name.as_deref(), Some("fix the build"));
        assert_eq!(s.model.as_deref(), Some("anthropic/claude-opus-4-8"));
        assert_eq!(s.version, Some(3));
        assert!(!s.truncated);
    }

    #[test]
    fn derives_a_truncated_first_line_when_session_has_no_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions").join("proj").join("session.jsonl");
        let first_line = "x".repeat(180);
        write(
            &path,
            &[
                r#"{"type":"session","version":3,"id":"019f","cwd":"/home/u/proj"}"#,
                &format!(
                    r#"{{"type":"message","id":"m1","message":{{"role":"user","content":"{first_line}\nsecond line"}}}}"#
                ),
            ],
        );

        let summary = summarize(&path, DEFAULT_FILE_CAP).unwrap().unwrap();
        let expected = format!("{}…", "x".repeat(140));

        assert_eq!(summary.name.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn parses_omp_shape_with_title_slot_and_string_model() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions").join("proj-bucket");
        // omp writes a fixed-width title slot line before the session header.
        write(
            &root.join("2026-08-12T01-00-00-000Z_0abc.jsonl"),
            &[
                "my session title                                                                                    xxxxxxxxxx",
                r#"{"type":"session","version":3,"id":"0abc","timestamp":"2026-08-12T01:00:00Z","cwd":"/w"}"#,
                r#"{"type":"model_change","model":"openrouter/z-ai/glm-5.3-flash"}"#,
                r#"{"type":"session_info","name":"newer name"}"#,
                r#"{"type":"session_info","name":"latest name"}"#,
            ],
        );
        let s = summarize(&root.join("2026-08-12T01-00-00-000Z_0abc.jsonl"), DEFAULT_FILE_CAP)
            .unwrap()
            .unwrap();
        assert_eq!(s.name.as_deref(), Some("latest name"));
        assert_eq!(s.model.as_deref(), Some("openrouter/z-ai/glm-5.3-flash"));
    }

    #[test]
    fn scans_newest_first_across_buckets_and_skips_foreign_files() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let a = sessions.join("--home-a--");
        let b = sessions.join("--home-b--");
        write(
            &a.join("2026-08-10T10-00-00-000Z_1.jsonl"),
            &[r#"{"type":"session","version":3,"id":"1","cwd":"/a"}"#],
        );
        write(
            &a.join("2026-08-11T10-00-00-000Z_2.jsonl"),
            &[r#"{"type":"session","version":3,"id":"2","cwd":"/a"}"#],
        );
        write(
            &b.join("2026-08-09T10-00-00-000Z_3.jsonl"),
            &[r#"{"type":"session","version":3,"id":"3","cwd":"/b"}"#],
        );
        // Foreign/partial files are skipped, not fatal.
        std::fs::write(a.join("2026-08-12T00-00-00-000Z_9.jsonl"), b"not a session at all\n").unwrap();
        std::fs::create_dir_all(sessions.join("nested-far")).unwrap();
        write(
            &sessions.join("nested-far").join("deeper").join("2026-08-13T00-00-00-000Z_4.jsonl"),
            &[r#"{"type":"session","version":3,"id":"4"}"#],
        ); // two levels deep: out of scan scope

        let h = FakeHarness(dir.path().to_path_buf());
        let out = scan(&h).unwrap();
        let ids: Vec<&str> = out.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["2", "1", "3"], "newest first, buckets grouped");
    }

    #[test]
    fn truncation_flag_respects_cap() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions").join("b");
        let path = root.join("2026-08-10T10-00-00-000Z_1.jsonl");
        std::fs::create_dir_all(&root).unwrap();
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, r#"{{"type":"session","version":3,"id":"1","cwd":"/a"}}"#).unwrap();
        writeln!(f, r#"{{"type":"session_info","name":"{}"}}"#, "x".repeat(4096)).unwrap();
        let s = summarize(&path, 256).unwrap().unwrap();
        assert!(s.truncated);
        // And the catalog scan surfaces it too.
        // The default-cap scan sees the whole file; an explicit small cap
        // must surface the truncation flag.
        let out = scan_root(&dir.path().join("sessions"), 256).unwrap();
        assert!(out.iter().any(|s| s.truncated));
    }

    #[test]
    fn missing_root_is_empty_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let h = FakeHarness(dir.path().to_path_buf());
        assert!(scan(&h).unwrap().is_empty());
    }
}
