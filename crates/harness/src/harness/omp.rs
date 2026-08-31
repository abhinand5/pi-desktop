//! OMP (Oh My Pi) harness adapter.
//!
//! Facts verified against omp 18.0.11 (live on this machine) and gooey-pi's
//! validated omp 17.x integration:
//! - `omp --mode rpc --cwd <dir>`; resume via `--resume <path>`; model via
//!   single `--model provider/id`; approvals via `--approval-mode`.
//! - Handshake: pushes `{"type":"ready","protocolVersion":1,...}`; the client
//!   answers `negotiate_protocol {protocolVersion:2}`, after which oversized
//!   frames arrive as base64 `rpc_chunk` sequences.
//! - Command renames: `fork`→`branch`, `get_fork_messages`→`get_branch_messages`.
//! - Event renames: `auto_compaction_*`→`compaction_*`; `agent_end` with
//!   `isTerminal:false` is a turn boundary, not an agent end (swallow).
//! - Credentials live in `~/.omp/agent/agent.db` (SQLite) — NEVER read or
//!   written by the desktop.
//! - Sessions: `~/.omp/agent/sessions/<bucket>/<ts>_<uuid>.jsonl`, v3 JSONL
//!   with a single-string `model` field in `model_change`.

use std::path::PathBuf;

use serde_json::Value;

use crate::harness::{agent_dir, CatalogKind, EventAction, Harness, HarnessId};
use crate::spec::{CatalogOptions, CommandSpec, SpawnOptions};

pub const BINARY: &str = "omp";

pub struct Omp;

impl Harness for Omp {
    fn id(&self) -> HarnessId {
        HarnessId::Omp
    }

    fn spawn_spec(&self, opts: &SpawnOptions) -> CommandSpec {
        let mut spec = CommandSpec::new(BINARY).arg("--mode").arg("rpc");
        if let Some(cwd) = &opts.cwd {
            spec = spec.arg("--cwd").arg(cwd.to_string_lossy().into_owned());
        }
        if let Some(path) = &opts.resume_path {
            spec = spec.arg("--resume").arg(path.to_string_lossy().into_owned());
        } else if opts.continue_last {
            spec = spec.arg("--continue");
        } else if opts.no_session {
            spec = spec.arg("--no-session");
        }
        if let Some(model) = &opts.model {
            spec = spec.arg("--model").arg(model.clone());
        }
        if let Some(level) = &opts.thinking {
            spec = spec.arg("--thinking").arg(level.clone());
        }
        if let Some(mode) = &opts.approval_mode {
            spec = spec.arg("--approval-mode").arg(mode.clone());
        }
        // The desktop bridge: session-tree navigation exists only in the
        // extension API, so the desktop ships one and loads it per-run.
        if let Some(path) = &opts.extension_path {
            spec = spec.arg("-e").arg(path.to_string_lossy().into_owned());
        }
        for a in &opts.extra_args {
            spec = spec.arg(a.clone());
        }
        spec
    }

    fn expects_ready_frame(&self) -> bool {
        true
    }

    fn needs_chunk_reassembly(&self) -> bool {
        true
    }

    fn translate_command(&self, cmd: &mut Value) {
        match cmd.get("type").and_then(Value::as_str) {
            Some("fork") => cmd["type"] = Value::from("branch"),
            Some("get_fork_messages") => cmd["type"] = Value::from("get_branch_messages"),
            _ => {}
        }
    }

    fn normalize_event(&self, ev: &mut Value) -> EventAction {
        match ev.get("type").and_then(Value::as_str) {
            Some("auto_compaction_start") => {
                ev["type"] = Value::from("compaction_start");
                EventAction::Pass
            }
            Some("auto_compaction_end") => {
                ev["type"] = Value::from("compaction_end");
                EventAction::Pass
            }
            // An agent_end with isTerminal:false is a turn boundary only.
            Some("agent_end") if ev.get("isTerminal").and_then(Value::as_bool) == Some(false) => EventAction::Swallow,
            _ => EventAction::Pass,
        }
    }

    fn agent_dir(&self) -> PathBuf {
        agent_dir("OMP_HOME", ".omp/agent")
    }

    /// omp's live source of truth after its one-time json migration.
    fn models_config_path(&self) -> PathBuf {
        self.agent_dir().join("models.yml")
    }

    fn catalog_kind(&self) -> CatalogKind {
        CatalogKind::JsonCli
    }

    fn catalog_spec(&self, _opts: &CatalogOptions) -> CommandSpec {
        CommandSpec::new(BINARY).arg("models").arg("--json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(opts: SpawnOptions) -> CommandSpec {
        Omp.spawn_spec(&opts)
    }

    #[test]
    fn argv_includes_cwd_flag() {
        let s = spec(SpawnOptions {
            cwd: Some("/home/u/proj".into()),
            no_session: true,
            ..Default::default()
        });
        assert_eq!(s.args, vec!["--mode", "rpc", "--cwd", "/home/u/proj", "--no-session"]);
    }

    #[test]
    fn resume_uses_resume_flag() {
        let s = spec(SpawnOptions { resume_path: Some("/tmp/s.jsonl".into()), ..Default::default() });
        assert_eq!(s.args, vec!["--mode", "rpc", "--resume", "/tmp/s.jsonl"]);
    }

    #[test]
    fn approval_mode_flag_only_when_set() {
        let s = spec(SpawnOptions { approval_mode: Some("write".into()), ..Default::default() });
        assert!(s.args.windows(2).any(|w| w == ["--approval-mode", "write"]));
        let s2 = spec(SpawnOptions::default());
        assert!(!s2.args.windows(2).any(|w| w == ["--approval-mode", "write"]));
    }

    #[test]
    fn handshake_and_chunking_declared() {
        assert!(Omp.expects_ready_frame());
        assert!(Omp.needs_chunk_reassembly());
        assert!(!crate::harness::pi::Pi.expects_ready_frame());
    }

    #[test]
    fn translates_fork_to_branch() {
        let mut cmd = json!({ "id": 1, "type": "fork", "entryId": "abc" });
        Omp.translate_command(&mut cmd);
        assert_eq!(cmd["type"], "branch");
        assert_eq!(cmd["entryId"], "abc");

        let mut cmd = json!({ "id": 2, "type": "get_fork_messages", "entryId": "abc" });
        Omp.translate_command(&mut cmd);
        assert_eq!(cmd["type"], "get_branch_messages");

        // Untouched vocabulary.
        let mut cmd = json!({ "id": 3, "type": "fork2" });
        Omp.translate_command(&mut cmd);
        assert_eq!(cmd["type"], "fork2");
    }

    #[test]
    fn normalizes_compaction_and_terminal_agent_end() {
        let mut ev = json!({ "type": "auto_compaction_start" });
        assert_eq!(Omp.normalize_event(&mut ev), EventAction::Pass);
        assert_eq!(ev["type"], "compaction_start");

        let mut ev = json!({ "type": "auto_compaction_end" });
        Omp.normalize_event(&mut ev);
        assert_eq!(ev["type"], "compaction_end");

        // Non-terminal agent_end is swallowed.
        let mut ev = json!({ "type": "agent_end", "isTerminal": false });
        assert_eq!(Omp.normalize_event(&mut ev), EventAction::Swallow);

        // Terminal agent_end passes.
        let mut ev = json!({ "type": "agent_end", "isTerminal": true });
        assert_eq!(Omp.normalize_event(&mut ev), EventAction::Pass);

        // Missing isTerminal passes (pi-style shapes).
        let mut ev = json!({ "type": "agent_end" });
        assert_eq!(Omp.normalize_event(&mut ev), EventAction::Pass);
    }

    #[test]
    fn catalog_is_json_cli() {
        assert_eq!(Omp.catalog_kind(), CatalogKind::JsonCli);
        let s = Omp.catalog_spec(&CatalogOptions::default());
        assert_eq!(s.args, vec!["models", "--json"]);
        assert_eq!(s.program, "omp");
        assert_eq!(s.cwd, None::<PathBuf>);
    }

    #[test]
    fn bridge_extension_flag() {
        let s = spec(SpawnOptions {
            cwd: Some("/home/u/proj".into()),
            extension_path: Some("/opt/pi-desktop/bridge.ts".into()),
            ..Default::default()
        });
        assert!(s.args.windows(2).any(|w| w == ["-e", "/opt/pi-desktop/bridge.ts"]));
        assert!(!spec(SpawnOptions::default()).args.iter().any(|a| a == "-e"));
    }
}
