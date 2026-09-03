//! Per-harness adapters. pi and omp share one JSONL RPC dialect with small,
//! verified differences; each adapter owns its harness's argv construction,
//! handshake behavior, command vocabulary, and event renames.

pub mod omp;
pub mod pi;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

pub use crate::spec::{CatalogOptions, CommandSpec, SpawnOptions};

pub use omp::Omp;
pub use pi::Pi;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum HarnessId {
    #[serde(rename = "pi")]
    Pi,
    #[serde(rename = "omp")]
    Omp,
}

/// What a client should do with a normalized event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventAction {
    /// Forward (possibly mutated) to subscribers.
    Pass,
    /// Drop silently (harness-internal bookkeeping).
    Swallow,
}

/// How the harness exposes its model catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogKind {
    /// Short-lived RPC probe answering `get_available_models` (pi).
    RpcProbe,
    /// One-shot CLI emitting JSON on stdout (`omp models --json`).
    JsonCli,
}

pub trait Harness: Send + Sync + 'static {
    fn id(&self) -> HarnessId;

    /// Native custom-provider config file for this harness.
    /// pi: `models.json` (JSON); omp: `models.yml` (YAML — the live source of
    /// truth; json is only migrated once and then ignored).
    fn models_config_path(&self) -> PathBuf {
        self.agent_dir().join("models.json")
    }

    /// Session storage root (JSONL files live in one bucket level below it).
    fn sessions_root(&self) -> PathBuf {
        self.agent_dir().join("sessions")
    }

    /// Builds the spawn argv for an interactive RPC runtime.
    /// Note: pi has no `--cwd` flag — callers must spawn with the project as
    /// the child's working directory; omp sets it via `--cwd`.
    fn spawn_spec(&self, opts: &SpawnOptions) -> CommandSpec;

    /// Whether the harness pushes a `ready` frame requiring protocol negotiation.
    fn expects_ready_frame(&self) -> bool {
        false
    }

    /// Whether protocol-v2 oversized frames arrive as base64 `rpc_chunk` sequences.
    fn needs_chunk_reassembly(&self) -> bool {
        false
    }

    /// In-place translation of a client command into harness vocabulary.
    fn translate_command(&self, cmd: &mut Value);

    /// In-place normalization of a harness event; may also drop it.
    fn normalize_event(&self, ev: &mut Value) -> EventAction;

    /// Agent config directory (`~/.pi/agent`, `~/.omp/agent`).
    fn agent_dir(&self) -> PathBuf;

    fn catalog_kind(&self) -> CatalogKind;

    /// Spawn spec for a one-shot catalog fetch.
    fn catalog_spec(&self, opts: &CatalogOptions) -> CommandSpec;
}

/// Returns the harness implementation for an id.
pub fn by_id(id: HarnessId) -> Arc<dyn Harness> {
    match id {
        HarnessId::Pi => Arc::new(Pi),
        HarnessId::Omp => Arc::new(Omp),
    }
}

/// Resolves the agent dir with an env override (`PI_HOME` for pi, as its
/// launcher scripts honor it; omp has no documented override).
fn agent_dir(env_key: &str, default: &str) -> PathBuf {
    match std::env::var(env_key) {
        Ok(v) if !v.trim().is_empty() => PathBuf::from(v),
        _ => dirs_home().join(default),
    }
}

/// The user's home directory.
///
/// `HOME` is a Unix convention and Windows does not set it, so reading only
/// that put every agent path under `/` on Windows — which is why the app showed
/// Unix-shaped paths there and then found nothing at them. Windows keeps the
/// same answer in `USERPROFILE`, or in `HOMEDRIVE` + `HOMEPATH` on a domain
/// account whose profile lives on a share.
fn dirs_home() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(home);
    }
    if cfg!(windows) {
        if let Some(profile) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            return PathBuf::from(profile);
        }
        if let (Some(drive), Some(path)) = (
            std::env::var_os("HOMEDRIVE").filter(|v| !v.is_empty()),
            std::env::var_os("HOMEPATH").filter(|v| !v.is_empty()),
        ) {
            let mut home = drive;
            home.push(path);
            return PathBuf::from(home);
        }
    }
    PathBuf::from("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_dir_respects_home() {
        // Default under HOME when env unset.
        unsafe { std::env::remove_var("__TEST_PI_HOME__") };
        let dir = agent_dir("__TEST_PI_HOME__", ".pi/agent");
        let home = dirs_home();
        assert_eq!(dir, home.join(".pi/agent"));
    }
}
