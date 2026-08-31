//! pi (pi.dev) harness adapter.
//!
//! Facts verified against pi 0.84.x (gooey-pi live validation + local docs at
//! /opt/pi-coding-agent/docs):
//! - `pi --mode rpc` speaks Prime-style JSONL: no ready frame, no negotiation,
//!   no chunked frames.
//! - No `--cwd` flag: the session bucket derives from the child's working
//!   directory, so the spawner must set the project dir as the child cwd.
//! - Resume uses `--session <path>` (`--resume` is an interactive selector).
//! - Model: `--model provider/id` (single flag) or split `--provider --model`.
//! - No tool-approval system: runs permanently unprompted.
//! - Sessions: `~/.pi/agent/sessions/--<cwd-with-dashes>--/<ts>_<uuid>.jsonl`,
//!   v3 JSONL with split `provider`/`modelId` in `model_change` entries.

use std::path::PathBuf;

use serde_json::Value;

use crate::harness::{agent_dir, CatalogKind, EventAction, Harness, HarnessId};
use crate::spec::{CatalogOptions, CommandSpec, SpawnOptions};

pub const BINARY: &str = "pi";

pub struct Pi;

impl Harness for Pi {
    fn id(&self) -> HarnessId {
        HarnessId::Pi
    }

    fn spawn_spec(&self, opts: &SpawnOptions) -> CommandSpec {
        let mut spec = CommandSpec::new(BINARY).arg("--mode").arg("rpc");
        if let Some(path) = &opts.resume_path {
            spec = spec.arg("--session").arg(path.to_string_lossy().into_owned());
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
        // The desktop bridge: session-tree navigation exists only in the
        // extension API, so the desktop ships one and loads it per-run.
        if let Some(path) = &opts.extension_path {
            spec = spec.arg("-e").arg(path.to_string_lossy().into_owned());
        }
        for a in &opts.extra_args {
            spec = spec.arg(a.clone());
        }
        // pi reads the working directory from the child process cwd.
        if let Some(cwd) = &opts.cwd {
            spec = spec.cwd(cwd.clone());
        }
        spec
    }

    fn translate_command(&self, _cmd: &mut Value) {
        // pi speaks the canonical vocabulary directly.
    }

    fn normalize_event(&self, _ev: &mut Value) -> EventAction {
        EventAction::Pass
    }

    fn agent_dir(&self) -> PathBuf {
        agent_dir("PI_HOME", ".pi/agent")
    }

    fn catalog_kind(&self) -> CatalogKind {
        CatalogKind::RpcProbe
    }

    fn catalog_spec(&self, _opts: &CatalogOptions) -> CommandSpec {
        CommandSpec::new(BINARY)
            .arg("--mode")
            .arg("rpc")
            .arg("--no-session")
            .arg("--offline")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(opts: SpawnOptions) -> CommandSpec {
        Pi.spawn_spec(&opts)
    }

    #[test]
    fn base_argv() {
        let s = spec(SpawnOptions { no_session: true, ..Default::default() });
        assert_eq!(s.args, vec!["--mode", "rpc", "--no-session"]);
        assert!(s.cwd.is_none(), "pi has no --cwd; cwd is the child process cwd");
    }

    #[test]
    fn resume_uses_session_flag_not_resume_selector() {
        let s = spec(SpawnOptions { resume_path: Some("/tmp/s.jsonl".into()), ..Default::default() });
        assert_eq!(s.args, vec!["--mode", "rpc", "--session", "/tmp/s.jsonl"]);
    }

    #[test]
    fn model_and_thinking_flags() {
        let s = spec(SpawnOptions {
            model: Some("anthropic/claude-opus-4-8".into()),
            thinking: Some("high".into()),
            ..Default::default()
        });
        assert_eq!(s.args, vec!["--mode", "rpc", "--model", "anthropic/claude-opus-4-8", "--thinking", "high"]);
    }

    #[test]
    fn cwd_lands_on_spec_not_argv() {
        let s = spec(SpawnOptions { cwd: Some("/home/u/proj".into()), ..Default::default() });
        assert_eq!(s.cwd.as_deref(), Some(std::path::Path::new("/home/u/proj")));
    }

    #[test]
    fn catalog_probe_is_offline_and_sessionless() {
        let s = Pi.catalog_spec(&CatalogOptions::default());
        assert_eq!(s.program, "pi");
        assert!(s.args.windows(2).any(|w| w == ["--no-session", "--offline"]));
    }

    #[test]
    fn events_pass_through() {
        let mut ev = serde_json::json!({ "type": "message_update" });
        assert_eq!(Pi.normalize_event(&mut ev), EventAction::Pass);
        assert_eq!(ev["type"], "message_update");
    }

    #[test]
    fn bridge_extension_flag() {
        let s = spec(SpawnOptions {
            extension_path: Some("/opt/pi-desktop/bridge.ts".into()),
            no_session: true,
            ..Default::default()
        });
        assert_eq!(s.args, vec!["--mode", "rpc", "--no-session", "-e", "/opt/pi-desktop/bridge.ts"]);
        // Absent unless asked for: a stock run must stay stock.
        assert!(!spec(SpawnOptions::default()).args.iter().any(|a| a == "-e"));
    }
}
