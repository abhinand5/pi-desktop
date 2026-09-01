//! Real terminals.
//!
//! Distinct from the agent-side `bash` command, which runs one command inside
//! the agent's own process and puts the output in its context. This is a
//! pseudo-terminal: a shell, or a harness TUI, with a controlling tty, its own
//! job control, and full escape-sequence handling on the frontend. It is what
//! you reach for when the thing you want to do is not a conversation.
//!
//! The desktop owns the process; the frontend owns the emulation. Bytes go up
//! a `Channel` exactly as read, base64-encoded — a read can split a UTF-8
//! sequence or an escape sequence in half, and only the terminal emulator is in
//! a position to reassemble them.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

/// What the frontend asked to run. `Shell` is the user's own login shell; the
/// harness variants run the real TUI rather than the RPC mode the chat uses.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PtyProgram {
    Shell,
    Pi,
    Omp,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    /// Raw bytes from the pty, base64-encoded.
    Output { data: String },
    /// The process ended. `code` is absent when it was signalled.
    Exit { code: Option<i32> },
    /// The pty could not be read from any further.
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub id: String,
    pub program: PtyProgram,
    pub cwd: String,
    pub host: Option<String>,
}

struct PtyEntry {
    // `MasterPty` is Send but not Sync, and the registry is shared across the
    // command threads, so the handle is guarded rather than held bare.
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    info: PtyInfo,
}

#[derive(Default)]
pub struct PtyState {
    ptys: Mutex<HashMap<String, Arc<PtyEntry>>>,
    next_id: AtomicU64,
}

fn ptys<'a>(state: &'a State<'_, PtyState>) -> std::sync::MutexGuard<'a, HashMap<String, Arc<PtyEntry>>> {
    state.ptys.lock().expect("pty registry lock poisoned")
}

/// The user's shell, or a sensible one. A terminal that opens in something
/// other than your own shell is a terminal you have to fight.
fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

/// Builds the command for a local pty.
fn local_command(program: PtyProgram, cwd: &str) -> CommandBuilder {
    let mut cmd = match program {
        PtyProgram::Shell => CommandBuilder::new(default_shell()),
        PtyProgram::Pi => CommandBuilder::new("pi"),
        PtyProgram::Omp => CommandBuilder::new("omp"),
    };
    cmd.cwd(cwd);
    apply_term_env(&mut cmd);
    cmd
}

/// Builds the command for a pty on an ssh host.
///
/// `-tt` forces a tty even though ssh's own stdin is one already — without it a
/// remote TUI gets a pipe and renders nothing. The remote command is a login
/// shell so the user's PATH is set before the harness is looked up.
fn remote_command(program: PtyProgram, cwd: &str, destination: &str, port: Option<u16>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("ssh");
    cmd.arg("-tt");
    if let Some(p) = port {
        cmd.arg("-p");
        cmd.arg(p.to_string());
    }
    cmd.arg(destination);
    let quoted = shell_quote(cwd);
    let inner = match program {
        PtyProgram::Shell => format!("cd {quoted} && exec ${{SHELL:-/bin/sh}} -l"),
        PtyProgram::Pi => format!("cd {quoted} && exec pi"),
        PtyProgram::Omp => format!("cd {quoted} && exec omp"),
    };
    cmd.arg(format!("$SHELL -l -c {}", shell_quote(&inner)));
    apply_term_env(&mut cmd);
    cmd
}

/// Single-quote for a POSIX shell, closing and reopening around any quote.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// What the frontend's emulator actually supports. Claiming less would cost
/// colour; claiming more would produce sequences it cannot draw.
fn apply_term_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
}

// Keep IPC fields independent so callers can invoke the Tauri command without
// nesting the PTY request shape; the state and channel are framework inputs.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn pty_open(
    state: State<'_, PtyState>,
    app: tauri::AppHandle,
    program: PtyProgram,
    cwd: String,
    host: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<PtyInfo, String> {
    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = NativePtySystem::default()
        .openpty(size)
        .map_err(|e| format!("could not open a terminal: {e}"))?;

    let cmd = match &host {
        None => local_command(program, &cwd),
        Some(alias) => {
            let entry = crate::runtime::ssh_host(&app, alias)?;
            remote_command(program, &cwd, &entry.destination, entry.port)
        }
    };

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| describe_spawn_failure(program, e))?;
    // The slave is the child's end. Holding it open here would keep the pty
    // alive after the child exits, so the reader would never see EOF.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("could not read from the terminal: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("could not write to the terminal: {e}"))?;

    let id = format!("pty-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let info = PtyInfo {
        id: id.clone(),
        program,
        cwd,
        host,
    };
    let entry = Arc::new(PtyEntry {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        info: info.clone(),
    });
    ptys(&state).insert(id.clone(), entry.clone());

    // A blocking read on its own thread: the pty has no async interface, and a
    // terminal's whole job is to deliver bytes the moment they exist.
    std::thread::Builder::new()
        .name(format!("pty-reader-{id}"))
        .spawn(move || pump(reader, on_event, entry))
        .map_err(|e| format!("could not start the terminal reader: {e}"))?;

    Ok(info)
}

fn pump(mut reader: Box<dyn Read + Send>, channel: Channel<PtyEvent>, entry: Arc<PtyEntry>) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                // A closed channel means the window is gone; nothing left to do.
                if channel.send(PtyEvent::Output { data }).is_err() {
                    return;
                }
            }
            Err(e) => {
                let _ = channel.send(PtyEvent::Error {
                    message: e.to_string(),
                });
                break;
            }
        }
    }

    let code = entry
        .child
        .lock()
        .ok()
        .and_then(|mut c| c.wait().ok())
        .map(|status| status.exit_code() as i32);
    let _ = channel.send(PtyEvent::Exit { code });
}

/// A missing binary is the common failure and the least self-explanatory.
fn describe_spawn_failure(program: PtyProgram, e: impl std::fmt::Display) -> String {
    match program {
        PtyProgram::Pi | PtyProgram::Omp => {
            let name = if program == PtyProgram::Pi { "pi" } else { "omp" };
            format!("could not start {name}: {e}. Is it on your PATH?")
        }
        PtyProgram::Shell => format!("could not start a shell: {e}"),
    }
}

#[tauri::command]
pub async fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let entry = ptys(&state).get(&id).cloned().ok_or("no such terminal")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut writer = entry.writer.lock().map_err(|_| "terminal write lock poisoned")?;
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let entry = ptys(&state).get(&id).cloned().ok_or("no such terminal")?;
    let master = entry.master.lock().map_err(|_| "terminal resize lock poisoned")?;
    master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let Some(entry) = ptys(&state).remove(&id) else {
        return Ok(());
    };
    if let Ok(mut child) = entry.child.lock() {
        let _ = child.kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn ptys_list(state: State<'_, PtyState>) -> Result<Vec<PtyInfo>, String> {
    Ok(ptys(&state).values().map(|e| e.info.clone()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_paths_a_shell_would_otherwise_split() {
        assert_eq!(shell_quote("/home/me/my papers"), "'/home/me/my papers'");
        assert_eq!(shell_quote("/tmp/it's"), r"'/tmp/it'\''s'");
    }

    #[test]
    fn remote_argv_forces_a_tty_and_carries_the_port() {
        let cmd = remote_command(PtyProgram::Omp, "/srv/work", "me@box", Some(2222));
        let argv: Vec<String> = cmd
            .get_argv()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert_eq!(argv[0], "ssh");
        assert!(argv.contains(&"-tt".to_string()), "{argv:?}");
        assert!(argv.contains(&"2222".to_string()), "{argv:?}");
        // Quoted twice on purpose: once for the login shell we ask ssh to run,
        // and once more because ssh hands its remaining argv to a shell as a
        // single string. Unquoting one level gives `cd '/srv/work' && exec omp`.
        let remote = argv.last().unwrap();
        assert!(remote.starts_with("$SHELL -l -c "), "{remote}");
        assert!(remote.contains(r"cd '\''/srv/work'\''"), "{remote}");
        assert!(remote.contains("exec omp"), "{remote}");
    }

    /// The whole path, minus Tauri: open a real pty, run a command in a real
    /// shell, and read the bytes back. Everything above this is plumbing.
    #[test]
    #[cfg(unix)]
    fn a_real_shell_runs_and_its_output_comes_back() {
        let pair = NativePtySystem::default()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "printf 'pty-works\\n'"]);
        apply_term_env(&mut cmd);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        // Without dropping the slave the pty never reaches EOF and the read
        // below blocks forever — the same reason `pty_open` drops it.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut out = String::new();
        reader.read_to_string(&mut out).expect("read");
        child.wait().expect("wait");

        assert!(out.contains("pty-works"), "{out:?}");
    }

    #[test]
    fn a_local_shell_runs_in_the_project() {
        let cmd = local_command(PtyProgram::Shell, "/home/me/papers");
        assert_eq!(cmd.get_cwd().map(|c| c.to_string_lossy().into_owned()), Some("/home/me/papers".into()));
    }
}
