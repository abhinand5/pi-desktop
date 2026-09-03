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

/// Finds an executable the way a shell would, and says how to run it.
///
/// This exists for Windows. `CreateProcess` searches PATH but only ever appends
/// `.exe`, while every shell also tries the suffixes in `PATHEXT` — which is
/// the whole difference between `pi` working in PowerShell and the same name
/// failing here. An agent installed through npm or bun is a `pi.cmd` shim, and
/// a shim is invisible to a bare `Command::new("pi")`.
///
/// Pure, so the lookup can be tested off Windows: the caller passes the search
/// path and the extension list rather than the function reading the
/// environment.
#[cfg(any(windows, test))]
pub(crate) fn find_on_path(program: &str, path: &str, pathext: &str) -> Option<PathBuf> {
    // An explicit path is already an answer.
    if program.contains('/') || program.contains('\\') {
        return None;
    }
    let separator = if cfg!(windows) { ';' } else { ':' };
    let already_suffixed = std::path::Path::new(program).extension().is_some();

    for dir in path.split(separator).filter(|d| !d.is_empty()) {
        let base = std::path::Path::new(dir).join(program);
        if already_suffixed && base.is_file() {
            return Some(base);
        }
        for ext in pathext.split(separator).filter(|e| !e.is_empty()) {
            // PATHEXT is conventionally upper case and the shims on disk are
            // conventionally lower case. Windows does not care, because its
            // filesystem does not; trying both means this resolves the same way
            // on a case-sensitive one, which is what makes it testable at all.
            for form in [ext.to_string(), ext.to_ascii_lowercase()] {
                let candidate = std::path::Path::new(dir).join(format!("{program}{form}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Rewrites a spec so Windows can actually start it.
///
/// Two steps, and both are needed. The binary is resolved through `PATHEXT` so
/// a `.cmd` shim is found at all; and a shim, once found, still cannot be
/// started directly — `CreateProcess` refuses a batch file — so it goes through
/// the command interpreter. A real `.exe` is started directly, which is the
/// common case and the one with no quoting surface.
#[cfg(windows)]
fn resolve_for_windows(mut spec: CommandSpec) -> CommandSpec {
    let path = std::env::var("PATH").unwrap_or_default();
    let pathext =
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let Some(found) = find_on_path(&spec.program, &path, &pathext) else { return spec };

    let batch = found
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);

    if batch {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut args = vec!["/c".to_string(), found.to_string_lossy().into_owned()];
        args.append(&mut spec.args);
        spec.program = comspec;
        spec.args = args;
    } else {
        spec.program = found.to_string_lossy().into_owned();
    }
    spec
}

impl Spawner for LocalSpawner {
    fn spawn(&self, spec: CommandSpec) -> BoxFuture<Result<ActiveProcess>> {
        Box::pin(async move {
            #[cfg(windows)]
            let spec = resolve_for_windows(spec);
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

#[cfg(test)]
mod tests {
    use super::find_on_path;

    /// A shell finds `pi.cmd`; `CreateProcess` looking only for `pi.exe` does
    /// not. That gap is the whole reason this function exists, so it is what
    /// the test pins.
    #[test]
    fn finds_a_shim_that_only_pathext_would_reach() {
        let dir = std::env::temp_dir().join(format!("pi-spec-{}", std::process::id()));
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).expect("temp bin");
        std::fs::write(bin.join("pi.cmd"), "@echo off\n").expect("write shim");

        let path = bin.to_string_lossy().into_owned();
        let sep = if cfg!(windows) { ";" } else { ":" };
        let pathext = [".COM", ".EXE", ".BAT", ".CMD"].join(sep);

        let found = find_on_path("pi", &path, &pathext).expect("shim found");
        assert_eq!(found.file_name().unwrap().to_string_lossy(), "pi.cmd");

        // A name the directory does not hold stays unfound, whatever the
        // suffix list says.
        assert!(find_on_path("omp", &path, &pathext).is_none());

        // An explicit path is already an answer and is left alone.
        assert!(find_on_path("./pi", &path, &pathext).is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prefers_the_earlier_directory_on_the_path() {
        let root = std::env::temp_dir().join(format!("pi-spec-order-{}", std::process::id()));
        let first = root.join("first");
        let second = root.join("second");
        std::fs::create_dir_all(&first).expect("first");
        std::fs::create_dir_all(&second).expect("second");
        std::fs::write(first.join("pi.exe"), "").expect("write");
        std::fs::write(second.join("pi.exe"), "").expect("write");

        let sep = if cfg!(windows) { ";" } else { ":" };
        let path = format!("{}{sep}{}", first.to_string_lossy(), second.to_string_lossy());
        let found = find_on_path("pi", &path, &format!(".EXE{sep}.CMD")).expect("found");

        assert!(found.starts_with(&first), "{found:?}");
        std::fs::remove_dir_all(&root).ok();
    }
}
