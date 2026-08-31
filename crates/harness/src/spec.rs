//! Process spawn abstraction: the same RPC client drives a local child process
//! today and an SSH exec channel tomorrow.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use crate::error::{Error, Result};

/// A fully-resolved command to execute. argv-only (no shell), with an optional
/// working directory and environment overlay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Environment variables layered over (or, with `env_clear`, instead of) the inherited env.
    pub env: BTreeMap<String, String>,
    /// When true, the child gets ONLY the vars in `env` plus a minimal safe set
    /// (PATH, HOME). Used for sanitized-mode spawns.
    pub env_clear: bool,
}

impl CommandSpec {
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
            env_clear: false,
        }
    }

    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }


    pub fn args<I: IntoIterator<Item = impl Into<String>>>(mut self, iter: I) -> Self {
        self.args.extend(iter.into_iter().map(Into::into));
        self
    }

    pub fn cwd(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cwd = Some(dir.into());
        self
    }
}

/// A spawned process with its stdio pipes.
pub struct ActiveProcess {
    pub child: tokio::process::Child,
    pub stdin: tokio::process::ChildStdin,
    pub stdout: tokio::process::ChildStdout,
    pub stderr: tokio::process::ChildStderr,
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Spawns a [`CommandSpec`]. Local spawn today; SSH exec channel later —
/// the RPC client is transport-agnostic.
pub trait Spawner: Send + Sync + 'static {
    fn spawn(&self, spec: CommandSpec) -> BoxFuture<Result<ActiveProcess>>;
}

/// Spawns via `tokio::process`, inheriting the user environment.
#[derive(Debug, Default, Clone, Copy)]
pub struct LocalSpawner;

impl Spawner for LocalSpawner {
    fn spawn(&self, spec: CommandSpec) -> BoxFuture<Result<ActiveProcess>> {
        Box::pin(async move {
            let mut cmd = tokio::process::Command::new(&spec.program);
            cmd.args(&spec.args).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
            if let Some(dir) = &spec.cwd {
                cmd.current_dir(dir);
            }
            if spec.env_clear {
                cmd.env_clear();
                for k in ["PATH", "HOME", "TMPDIR"] {
                    if let Ok(v) = std::env::var(k) {
                        cmd.env(k, v);
                    }
                }
            }
            for (k, v) in &spec.env {
                cmd.env(k, v);
            }
            let mut child = cmd.kill_on_drop(true).spawn().map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    Error::BinaryNotFound(spec.program.clone())
                } else {
                    Error::Spawn(e.to_string())
                }
            })?;
            let stdin = child.stdin.take().ok_or_else(|| Error::Spawn("no stdin".into()))?;
            let stdout = child.stdout.take().ok_or_else(|| Error::Spawn("no stdout".into()))?;
            let stderr = child.stderr.take().ok_or_else(|| Error::Spawn("no stderr".into()))?;
            Ok(ActiveProcess { child, stdin, stdout, stderr })
        })
    }
}

/// Options for spawning an interactive agent runtime.
#[derive(Debug, Clone, Default)]
pub struct SpawnOptions {
    /// Project directory the agent operates on.
    pub cwd: Option<PathBuf>,
    /// Session file to resume (pi: `--session <path>`, omp: `--resume <path>`).
    pub resume_path: Option<PathBuf>,
    /// Model selector, `provider/model-id` (e.g. `anthropic/claude-opus-4-8`).
    pub model: Option<String>,
    /// Thinking level: off|minimal|low|medium|high|xhigh|max.
    pub thinking: Option<String>,
    /// omp-only tool approval mode: always-ask|write|yolo.
    pub approval_mode: Option<String>,
    /// Ephemeral session (no persistence).
    pub no_session: bool,
    /// Continue the most recent session in this cwd (harness `-c/--continue`).
    pub continue_last: bool,
    /// Desktop bridge extension loaded per-run via `-e <path>`. Both harnesses
    /// accept the flag and expose the same extension API, which is the only
    /// route to session-tree navigation — no RPC command reaches it.
    pub extension_path: Option<PathBuf>,
    /// Extra raw argv appended verbatim (extensions, harness-specific flags).
    pub extra_args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogOptions {
    /// Byte cap for catalog output (untrusted input guard).
    pub byte_cap: u64,
}

impl Default for CatalogOptions {
    fn default() -> Self {
        Self { byte_cap: 8 * 1024 * 1024 }
    }
}
