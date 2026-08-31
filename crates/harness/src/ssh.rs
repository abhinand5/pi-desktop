//! SSH execution-host support.
//!
//! Model: the agent runtime runs ON the remote box; the desktop speaks the
//! same stdio JSONL RPC through an SSH exec channel (`ssh host -- omp --mode
//! rpc ...`). Reconnect = re-spawn with `--resume <sessionPath>`; session
//! files live on the remote disk and survive disconnects.
//!
//! System `ssh` only (no libssh2): ProxyJump, agents, known-hosts, and
//! extra exec channels (file browsing, tunnels) reuse one authenticated
//! connection.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::spec::CommandSpec;

/// Per-connection ssh options: multiplex via ControlMaster, TOFU host-key
/// acceptance, no password prompts (RPC must never hang on a TTY prompt —
/// use keys or an agent).
pub const SSH_OPTIONS: &[&str] = &[
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=600",
    "-o",
    "StrictHostKeyChecking=accept-new",
];

/// Wraps an inner command so it executes on `host` through system ssh.
/// The child's stdin/stdout are the remote process's stdin/stdout — the RPC
/// client cannot tell the difference from a local spawn.
pub fn wrap(
    host: &str,
    port: Option<u16>,
    reverse_port: Option<u16>,
    inner: &CommandSpec,
) -> CommandSpec {
    let mut args: Vec<String> = SSH_OPTIONS.iter().map(|s| s.to_string()).collect();
    if let Some(p) = port {
        args.push("-p".into());
        args.push(p.to_string());
    }
    if let Some(rp) = reverse_port {
        // Reverse tunnel: the remote's 127.0.0.1:rp is forwarded to the
        // desktop's egress proxy — the offline-remote egress path.
        args.push("-R".into());
        args.push(format!("127.0.0.1:{rp}:127.0.0.1:{rp}"));
    }
    args.push(host.to_string());
    args.push("--".into());
    if !inner.env.is_empty() {
        args.push("env".into());
        for (k, v) in &inner.env {
            args.push(format!("{k}={v}"));
        }
    }
    args.push(inner.program.clone());
    args.extend(inner.args.iter().cloned());
    CommandSpec::new("ssh").args(args)
}

/// Builds the remote-bootstrap command: run the harness installer through
/// the reverse tunnel so the install works on a box with NO internet. The
/// pipe runs remotely; the egress env points at the desktop's proxy via the
/// forwarded loopback port.
pub fn bootstrap_spec(
    host: &str,
    port: Option<u16>,
    tunnel_port: u16,
    install_script_url: &str,
) -> CommandSpec {
    let mut args: Vec<String> = SSH_OPTIONS.iter().map(|s| s.to_string()).collect();
    if let Some(p) = port {
        args.push("-p".into());
        args.push(p.to_string());
    }
    args.push("-R".into());
    args.push(format!("127.0.0.1:{tunnel_port}:127.0.0.1:{tunnel_port}"));
    args.push(host.to_string());
    args.push("--".into());
    args.push("env".into());
    args.push(format!("HTTPS_PROXY=http://127.0.0.1:{tunnel_port}"));
    args.push(format!("HTTP_PROXY=http://127.0.0.1:{tunnel_port}"));
    args.push("NO_PROXY=localhost,127.0.0.1".into());
    args.push("sh".into());
    args.push("-c".into());
    args.push(format!("curl -fsSL {install_script_url} | sh"));
    CommandSpec::new("ssh").args(args)
}

pub fn probe_spec(host: &str, port: Option<u16>) -> CommandSpec {
    let mut args: Vec<String> = SSH_OPTIONS.iter().map(|s| s.to_string()).collect();
    if let Some(p) = port {
        args.push("-p".into());
        args.push(p.to_string());
    }
    args.push(host.to_string());
    args.push("--".into());
    args.push("echo".into());
    args.push("pong".into());
    CommandSpec::new("ssh").args(args)
}

/// Remote path expansion for the agent dir (`~/.omp/agent` style) — evaluated
/// by the REMOTE shell, not locally, so `~` is safe in stored paths.
pub fn remote_models_config_path(harness: &str) -> String {
    match harness {
        "pi" => "~/.pi/agent/models.json".into(),
        _ => "~/.omp/agent/models.yml".into(),
    }
}

// ---------- host registry ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostEntry {
    /// Display alias (also the registry key).
    pub alias: String,
    /// `user@hostname` (ssh destination string).
    pub destination: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_args: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct HostRegistry {
    pub hosts: Vec<HostEntry>,
}

pub fn registry_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("ssh-hosts.json")
}

pub fn load_registry(data_dir: &std::path::Path) -> HostRegistry {
    let path = registry_path(data_dir);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => HostRegistry::default(),
    }
}

pub fn save_registry(data_dir: &std::path::Path, registry: &HostRegistry) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = registry_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(registry)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Validates a host alias and destination before touching the registry.
pub fn validate_host(alias: &str, destination: &str) -> Result<()> {
    if alias.is_empty() || !alias.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(Error::Other("alias: letters, digits, '-' and '_' only".into()));
    }
    if destination.is_empty() || destination.starts_with('-') {
        return Err(Error::Other("destination must be a user@host string".into()));
    }
    Ok(())
}

/// Extracts the remote session-file path from a `get_state` response, if the
/// runtime tracks one.
pub fn session_file_from_state(state: &Value) -> Option<String> {
    state
        .get("data")
        .and_then(|d| d.get("sessionFile"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inner() -> CommandSpec {
        CommandSpec::new("omp")
            .arg("--mode")
            .arg("rpc")
            .arg("--cwd")
            .arg("~/proj")
            .env("HTTPS_PROXY", "http://127.0.0.1:18080")
    }

    #[test]
    fn wrap_builds_ssh_argv_with_env_and_options() {
        let s = wrap("gpu-box", None, None, &inner());
        assert_eq!(s.program, "ssh");
        assert!(s.args.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
        assert!(s.args.contains(&"--".to_string()));
        let dd = s.args.iter().position(|a| a == "--").unwrap();
        // env overlay injected right after `--`
        assert_eq!(s.args[dd + 1], "env");
        assert!(s.args[dd + 2].starts_with("HTTPS_PROXY="));
        assert_eq!(s.args[dd + 3], "omp");
        // remote cwd is inside the remote command (harness set --cwd ~/proj)
        assert!(s.args.contains(&"~/proj".to_string()));
    }

    #[test]
    fn wrap_with_port_and_reverse() {
        let s = wrap("box", Some(2222), Some(18080), &inner());
        // -p before -R before host, then the `--` separator.
        let pp = s.args.iter().position(|a| a == "-p").unwrap();
        assert_eq!(s.args[pp + 1], "2222");
        let rr = s.args.iter().position(|a| a == "-R").unwrap();
        assert_eq!(s.args[rr + 1], "127.0.0.1:18080:127.0.0.1:18080");
        let dd = s.args.iter().position(|a| a == "--").unwrap();
        assert_eq!(s.args[dd - 1], "box");
    }

    #[test]
    fn wrap_without_reverse_has_no_forward() {
        let s = wrap("box", None, None, &inner());
        assert!(!s.args.contains(&"-R".to_string()));
    }

    #[test]
    fn probe_uses_echo_pong() {
        let s = probe_spec("box", None);
        assert_eq!(s.program, "ssh");
        let dd = s.args.iter().position(|a| a == "--").unwrap();
        assert_eq!(s.args[dd - 1], "box");
        assert_eq!(&s.args[dd + 1..], &["echo", "pong"]);
    }

    #[test]
    fn bootstrap_runs_installer_through_tunnel() {
        let s = bootstrap_spec("box", None, 18080, "https://example.com/install.sh");
        assert_eq!(s.program, "ssh");
        assert!(s
            .args
            .contains(&"127.0.0.1:18080:127.0.0.1:18080".to_string()));
        let dd = s.args.iter().position(|a| a == "--").unwrap();
        // egress env before the shell one-liner
        assert!(s.args[dd + 1..].iter().any(|a| a.starts_with("HTTPS_PROXY=http://127.0.0.1:18080")));
        assert!(s.args[dd + 1..].contains(&"sh".to_string()));
        assert!(s.args[dd + 1..].iter().any(|a| a.contains("https://example.com/install.sh")));
    }

    #[test]
    fn registry_round_trip_and_validation() {
        let dir = tempfile::tempdir().unwrap();
        let mut reg = load_registry(dir.path());
        reg.hosts.push(HostEntry {
            alias: "gpu".into(),
            destination: "abe@gpu.lan".into(),
            port: Some(22),
            extra_args: vec![],
        });
        save_registry(dir.path(), &reg).unwrap();
        let loaded = load_registry(dir.path());
        assert_eq!(loaded.hosts.len(), 1);
        assert_eq!(loaded.hosts[0].destination, "abe@gpu.lan");

        assert!(validate_host("ok", "u@h").is_ok());
        assert!(validate_host("", "u@h").is_err());
        assert!(validate_host("bad alias", "u@h").is_err());
        assert!(validate_host("ok", "").is_err());
        assert!(validate_host("ok", "-weird").is_err());
    }

    #[test]
    fn session_file_extraction() {
        let v: Value = serde_json::json!({
            "type": "response", "success": true,
            "data": { "sessionFile": "~/.omp/agent/sessions/b/2026.jsonl" }
        });
        assert_eq!(session_file_from_state(&v).as_deref(), Some("~/.omp/agent/sessions/b/2026.jsonl"));
        assert_eq!(session_file_from_state(&serde_json::json!({})), None);
    }
}
