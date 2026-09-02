//! Desktop-side runtime management: owns live agent processes and bridges
//! their JSONL event streams to the webview via Tauri IPC channels.
//!
//! One runtime = one `harness::RpcClient` (local transport today, SSH exec
//! later — commands and events are identical for both).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use harness::client::RpcClient;
use harness::harness::{by_id, HarnessId};
use harness::spec::{CommandSpec, LocalSpawner, SpawnOptions, Spawner};
use harness::ssh;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "data")]
pub enum BridgeEvent {
    /// Normalized harness event.
    Event(Value),
    /// The runtime exited.
    Exited { code: Option<i32>, error: Option<String>, stderr: String },
}

pub struct RuntimeEntry {
    pub id: String,
    pub harness_id: HarnessId,
    pub client: RpcClient,
    /// Kept alive for the runtime's lifetime; Drop closes the tunnel.
    #[allow(dead_code)]
    pub egress_proxy: Option<harness::proxy::EgressProxy>,
    pub host: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub id: String,
    pub harness: String,
    pub pid: Option<u32>,
    pub exited: bool,
    pub host: Option<String>,
}

#[derive(Default)]
pub struct AppState {
    runtimes: Mutex<HashMap<String, Arc<RuntimeEntry>>>,
    next_id: AtomicU64,
}

fn state_runtimes<'a>(state: &'a State<'_, AppState>) -> std::sync::MutexGuard<'a, HashMap<String, Arc<RuntimeEntry>>> {
    state.runtimes.lock().expect("runtimes lock poisoned")
}

/// The bundled session-tree bridge. Session-tree navigation exists only in the
/// harness extension API — no RPC command reaches it — so the desktop ships an
/// extension and loads it per-run with `-e`. Absent in an unbundled checkout,
/// in which case the UI falls back to fork-per-branch.
fn bridge_extension_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let bundled = app
        .path()
        .resolve("resources/pi-desktop-bridge.ts", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists());
    if bundled.is_some() {
        return bundled;
    }
    // `cargo test` / `cargo run` outside a bundle: fall back to the source tree.
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/pi-desktop-bridge.ts");
    source.exists().then_some(source)
}

/// Copies the bridge to the remote host so `-e` resolves there. Content-hashed
/// so repeated starts reuse one file and concurrent versions never collide.
async fn push_bridge_remote(
    local: &Path,
    destination: &str,
    port: Option<u16>,
) -> Result<PathBuf, String> {
    use tokio::io::AsyncWriteExt;
    let body = tokio::fs::read(local).await.map_err(|e| format!("read bridge: {e}"))?;
    let digest = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        body.hash(&mut h);
        h.finish()
    };
    let remote = format!("/tmp/pi-desktop-bridge-{digest:016x}.ts");
    let mut args: Vec<String> = harness::ssh::SSH_OPTIONS.iter().map(|s| s.to_string()).collect();
    if let Some(p) = port {
        args.push("-p".into());
        args.push(p.to_string());
    }
    args.push(destination.to_string());
    // Write to a per-process temp name, then rename: a half-written bridge is
    // never visible under the final path, even with two starts racing.
    args.push(format!("t=$(mktemp {remote}.XXXXXX) && cat > \"$t\" && mv -f \"$t\" {remote}"));
    let spec = CommandSpec::new("ssh").args(args);
    let harness::spec::ActiveProcess { mut child, mut stdin, .. } =
        LocalSpawner.spawn(spec).await.map_err(|e| format!("ssh: {e}"))?;
    stdin.write_all(&body).await.map_err(|e| format!("send bridge: {e}"))?;
    drop(stdin);
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("could not install the session bridge on {destination}"));
    }
    Ok(PathBuf::from(remote))
}

/// Spawns an agent runtime — locally or on a registered SSH host — and
/// streams its events to `on_event`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // tauri commands map 1:1 to IPC params
pub async fn runtime_start(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    harness: String,
    cwd: String,
    host: Option<String>,
    session_path: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    approval_mode: Option<String>,
    no_session: bool,
    // Continue the most recent session in the project cwd.
    continue_last: bool,
    // Reverse-tunnel the desktop's egress to the remote agent (offline
    // remotes). Defaults to true whenever a host is set.
    egress: Option<bool>,
    // Broker mode: extra env injected into the remote agent, e.g.
    // `{"OPENAI_API_KEY":"sk-…"}` obtained via `auth_print_key`.
    broker_env: Option<Value>,
    on_event: Channel<BridgeEvent>,
) -> Result<RuntimeInfo, String> {
    let harness_id: HarnessId =
        serde_json::from_value(Value::String(harness.clone())).map_err(|e| e.to_string())?;
    let h = by_id(harness_id);

    let local_bridge = bridge_extension_path(&app);
    let mut opts = SpawnOptions {
        cwd: Some(PathBuf::from(&cwd)),
        resume_path: session_path.map(PathBuf::from),
        model,
        thinking,
        approval_mode,
        no_session,
        continue_last,
        extension_path: local_bridge.clone(),
        extra_args: Vec::new(),
    };

    // Remote target: wrap the harness argv in an ssh exec channel. The RPC
    // client cannot tell the difference from a local spawn. With egress on,
    // a reverse tunnel carries remote model traffic through this machine.
    let mut proxy: Option<harness::proxy::EgressProxy> = None;
    let remote_entry = match &host {
        None => None,
        Some(alias) => Some(ssh_host(&app, alias)?),
    };

    // A local path means nothing on the far side, so ship the bridge across
    // before argv is built. A failed push is not fatal: the session still runs,
    // it just loses in-place branching.
    if let (Some(entry), Some(local)) = (remote_entry.as_ref(), local_bridge.as_ref()) {
        match push_bridge_remote(local, &entry.destination, entry.port).await {
            Ok(remote) => opts.extension_path = Some(remote),
            Err(e) => {
                tracing::warn!(host = %entry.alias, error = %e, "bridge push failed; branching degraded");
                opts.extension_path = None;
            }
        }
    }

    let mut spec: CommandSpec = h.spawn_spec(&opts);

    // Broker mode: inject credential env before transport wrapping.
    if let Some(env) = &broker_env {
        if let Some(map) = env.as_object() {
            for (k, v) in map {
                if let Some(val) = v.as_str() {
                    spec = spec.env(k.clone(), val.to_string());
                }
            }
        }
    }

    let (spec, via_host) = match remote_entry {
        None => (spec, None),
        Some(entry) => {
            let alias = entry.alias.clone();
            let reverse_port = if egress.unwrap_or(true) {
                let p = harness::proxy::start().await.map_err(|e| format!("egress proxy: {e}"))?;
                let port = p.port();
                proxy = Some(p);
                for (k, v) in [
                    ("HTTPS_PROXY", format!("http://127.0.0.1:{port}")),
                    ("HTTP_PROXY", format!("http://127.0.0.1:{port}")),
                    ("NO_PROXY", "localhost,127.0.0.1".to_string()),
                ] {
                    spec = spec.env(k, v);
                }
                Some(port)
            } else {
                None
            };
            (ssh::wrap(&entry.destination, entry.port, reverse_port, &spec), Some(alias))
        }
    };

    let client = RpcClient::spawn(h, &LocalSpawner, spec)
        .await
        .map_err(|e| format!("spawn failed: {e}"))?;

    let id = format!("rt-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let info = RuntimeInfo {
        id: id.clone(),
        harness: harness.clone(),
        pid: client.pid(),
        exited: false,
        host: via_host.clone(),
    };

    // Forward loop: broadcast events → IPC channel. Subscribed before any
    // user command is issued, so nothing observable is missed.
    let mut rx = client.subscribe();
    let mut exit_rx = client.exit();
    let runtime_id = id.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                ev = rx.recv() => match ev {
                    Ok(ev) => {
                        if on_event.send(BridgeEvent::Event(ev.value().clone())).is_err() {
                            break; // webview gone
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(runtime = %runtime_id, lost = n, "event lag; UI must resync");
                        // Delivery contract: the UI replays via get_messages on lag.
                        let _ = on_event.send(BridgeEvent::Event(serde_json::json!({
                            "type": "runtime_lagged",
                            "lost": n
                        })));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                changed = exit_rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let info = exit_rx.borrow().clone();
                    if let Some(info) = info {
                        let _ = on_event.send(BridgeEvent::Exited {
                            code: info.code,
                            error: info.error,
                            stderr: String::new(),
                        });
                        break;
                    }
                }
            }
        }
    });

    let entry = Arc::new(RuntimeEntry { id: id.clone(), harness_id, host: via_host.clone(), egress_proxy: proxy, client });
    state_runtimes(&state).insert(id, entry);
    Ok(info)
}

/// Desktop-broker mode (pi harness only): resolves a stored API key through
/// pi's own credential interface and hands it to the frontend for injection
/// as broker env on the next remote start.
#[tauri::command]
pub async fn auth_print_key(provider: String) -> Result<String, String> {
    let out = tokio::process::Command::new("pi")
        .args(["auth", "print-api-key", "--provider", &provider])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "pi auth failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Installs the harness on a remote host through a temporary reverse tunnel,
/// so bootstrap works on boxes with no internet.
#[tauri::command]
pub async fn ssh_bootstrap(
    host: String,
    port: Option<u16>,
    harness: HarnessParam,
) -> Result<String, String> {
    let install_url = match harness {
        HarnessParam::Pi => "https://pi.dev/install.sh",
        HarnessParam::Omp => "https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh",
    };
    let proxy = harness::proxy::start().await.map_err(|e| e.to_string())?;
    let spec = ssh::bootstrap_spec(&host, port, proxy.port(), install_url);
    let harness::spec::ActiveProcess { mut child, stdin: _, mut stdout, stderr: _ } = LocalSpawner
        .spawn(spec)
        .await
        .map_err(|e| format!("ssh failed: {e}"))?;
    let mut buf = Vec::new();
    {
        use tokio::io::AsyncReadExt;
        tokio::time::timeout(std::time::Duration::from_secs(600), stdout.read_to_end(&mut buf))
            .await
            .map_err(|_| "bootstrap timed out".to_string())?
            .map_err(|e| e.to_string())?;
    }
    let _ = child.wait().await;
    let text = String::from_utf8_lossy(&buf).into_owned();
    Ok(text.lines().rev().take(15).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
}


// ---------- Session tree (read-only, over the harness's own JSONL) ----------

/// Reads a session's entry tree straight from its file. Works for both
/// harnesses, for live and finished sessions, and — unlike pi's `get_tree`
/// RPC, which omp lacks entirely — without a running runtime, so a session can
/// be previewed before it is opened.
///
/// `lastEntryId` is the last *appended* entry, which is the leaf only until
/// someone navigates: leaf movement is in-memory and writes nothing. While a
/// runtime is attached, the live leaf comes from the harness instead.
#[tauri::command]
pub fn session_tree(path: String) -> Result<harness::SessionTree, String> {
    harness::read_tree(Path::new(&path)).map_err(|e| e.to_string())
}

/// Reads a remote session file over ssh and parses it locally, so the tree
/// works the same on an SSH target as on this machine.
#[tauri::command]
pub async fn session_tree_remote(
    host: String,
    port: Option<u16>,
    path: String,
) -> Result<harness::SessionTree, String> {
    let body = ssh_fs_read(host, port, path).await?;
    harness::tree::read_tree_bytes(body.as_bytes()).map_err(|e| e.to_string())
}

/// Deletes a session file. The one write the desktop makes to the harness's
/// own storage, so it is deliberate and narrow: the path must sit under a
/// harness sessions root and end in `.jsonl`, and deletion goes through the
/// `trash` CLI when it is available, exactly as pi's own `/resume` does.
#[tauri::command]
pub async fn session_delete(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if target.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("only .jsonl session files can be removed".into());
    }
    let under_a_sessions_root = [HarnessId::Pi, HarnessId::Omp]
        .iter()
        .any(|id| target.starts_with(by_id(*id).sessions_root()));
    if !under_a_sessions_root {
        return Err("that file is not in a harness session directory".into());
    }
    if tokio::process::Command::new("trash")
        .arg(&path)
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
    {
        return Ok(());
    }
    tokio::fs::remove_file(target).await.map_err(|e| e.to_string())
}

/// Aggregate usage across every session file the harness has written. Derived
/// entirely from those files — the desktop keeps no telemetry of its own — so
/// the figures cover TUI sessions as well as ones driven from here.
#[tauri::command]
pub fn usage_report(harness: HarnessParam, since_days: Option<u32>) -> Result<harness::UsageReport, String> {
    let h = by_id(match harness {
        HarnessParam::Pi => HarnessId::Pi,
        HarnessParam::Omp => HarnessId::Omp,
    });
    harness::usage::report(&*h, since_days).map_err(|e| e.to_string())
}

// ---------- Local project inspection (file picker, git readout) ----------

/// Lists a local directory for the composer's `@` file picker. Hidden entries
/// and heavy build directories are skipped: they are noise in a mention list.
#[tauri::command]
pub async fn fs_list(path: String) -> Result<Vec<FsEntry>, String> {
    const SKIP: [&str; 8] =
        ["node_modules", "target", "dist", "build", ".git", ".venv", "__pycache__", ".next"];
    let mut out = Vec::new();
    let mut dir = tokio::fs::read_dir(&path).await.map_err(|e| e.to_string())?;
    while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIP.contains(&name.as_str()) {
            continue;
        }
        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        out.push(FsEntry { name, is_dir, path: entry.path().to_string_lossy().into_owned() });
    }
    // Directories first, then alphabetical — the order a picker is read in.
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}
/// The app-owned default for generic sessions. A custom path can replace it
/// without changing the session protocol or the local-only execution rule.
fn default_scratch_workspace(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;

    app.path()
        .app_data_dir()
        .map(|path| path.join("scratch-workspaces"))
        .map_err(|e| format!("resolve app data directory: {e}"))
}

fn expand_scratch_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return home.join(rest);
    }
    PathBuf::from(path)
}

fn create_scratch_session(root: &Path) -> Result<PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    for attempt in 0..100 {
        let candidate = root.join(format!("session-{stamp:x}-{attempt}"));
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create scratch session: {error}")),
        }
    }
    Err("create scratch session: too many name collisions".into())
}

/// Resolves and creates a fresh local app-owned scratch session directory.
/// Scratch sessions deliberately stay local, even when an SSH host is selected
/// for project work.
#[tauri::command]
pub fn scratch_workspace(app: tauri::AppHandle, path: Option<String>) -> Result<String, String> {
    use tauri::Manager;

    let configured = path.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let root = if let Some(configured) = configured {
        let home = app.path().home_dir().map_err(|e| format!("resolve home directory: {e}"))?;
        let root = expand_scratch_home(configured, &home);
        if !root.is_absolute() {
            return Err("scratch workspace path must be absolute or start with ~".into());
        }
        root
    } else {
        default_scratch_workspace(&app)?
    };

    std::fs::create_dir_all(&root).map_err(|e| format!("create scratch workspace: {e}"))?;
    create_scratch_session(&root).map(|path| path.to_string_lossy().into_owned())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImage {
    pub data: String,
    pub mime_type: String,
}

fn encode_rgba_png(bytes: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut encoder = png::Encoder::new(&mut output, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| format!("encode clipboard image: {e}"))?;
    writer
        .write_image_data(bytes)
        .map_err(|e| format!("encode clipboard image pixels: {e}"))?;
    writer.finish().map_err(|e| format!("finish clipboard image: {e}"))?;
    Ok(output)
}

/// Reads a still image from the OS clipboard off the main thread. WebKitGTK can
/// hide image data from paste events, and clipboard access can deadlock Linux
/// webviews when performed on their UI thread.
#[tauri::command]
pub async fn clipboard_image() -> Result<Option<ClipboardImage>, String> {
    tokio::task::spawn_blocking(|| {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("open clipboard: {e}"))?;
        let image = match clipboard.get_image() {
            Ok(image) => image,
            Err(arboard::Error::ContentNotAvailable) => return Ok(None),
            Err(error) => return Err(format!("read clipboard image: {error}")),
        };
        let data = encode_rgba_png(image.bytes.as_ref(), image.width as u32, image.height as u32)?;
        Ok(Some(ClipboardImage {
            data: base64::engine::general_purpose::STANDARD.encode(data),
            mime_type: "image/png".into(),
        }))
    })
    .await
    .map_err(|e| format!("read clipboard image task: {e}"))?
}


#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub changed: usize,
    pub staged: usize,
}

/// Branch and dirty count for the composer status bar. A missing git, or a
/// folder that is not a repo, is a normal answer rather than an error.
#[tauri::command]
pub async fn git_status(cwd: String) -> Result<GitStatus, String> {
    let run = |args: Vec<&str>| {
        let cwd = cwd.clone();
        let args: Vec<String> = args.into_iter().map(String::from).collect();
        async move {
            tokio::process::Command::new("git")
                .args(&args)
                .current_dir(&cwd)
                .output()
                .await
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        }
    };

    let Some(branch) = run(vec!["rev-parse", "--abbrev-ref", "HEAD"]).await else {
        return Ok(GitStatus::default());
    };
    let porcelain = run(vec!["status", "--porcelain"]).await.unwrap_or_default();
    let (mut changed, mut staged) = (0usize, 0usize);
    for line in porcelain.lines() {
        let mut chars = line.chars();
        let index = chars.next().unwrap_or(' ');
        let worktree = chars.next().unwrap_or(' ');
        if index != ' ' && index != '?' {
            staged += 1;
        }
        if worktree != ' ' {
            changed += 1;
        }
    }
    Ok(GitStatus { is_repo: true, branch: Some(branch.trim().to_string()), changed, staged })
}

// ---------- Remote file browsing (ssh exec, ls -Apl) ----------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
    pub path: String,
}

/// Single-quotes a path for safe passage through the remote shell.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn ssh_transport_args(host: &str, port: Option<u16>) -> Vec<String> {
    let mut args: Vec<String> = harness::ssh::SSH_OPTIONS.iter().map(|s| s.to_string()).collect();
    if let Some(p) = port {
        args.push("-p".into());
        args.push(p.to_string());
    }
    args.push(host.to_string());
    args
}

#[tauri::command]
pub async fn ssh_fs_list(host: String, port: Option<u16>, path: String) -> Result<Vec<FsEntry>, String> {
    if path.is_empty() {
        return Err("path required".into());
    }
    // ls -Apl: one entry per line, dirs carry a trailing "/" — the most
    // portable listing across GNU/BSD/busybox remotes.
    let remote = format!("ls -Apl -- {}", sh_quote(&path));
    let mut args = ssh_transport_args(&host, port);
    args.push(remote);
    let mut active = LocalSpawner
        .spawn(CommandSpec::new("ssh").args(args))
        .await
        .map_err(|e| format!("ssh failed: {e}"))?;
    let mut buf = Vec::new();
    {
        use tokio::io::AsyncReadExt;
        tokio::time::timeout(std::time::Duration::from_secs(20), active.stdout.read_to_end(&mut buf))
            .await
            .map_err(|_| "list timed out".to_string())?
            .map_err(|e| e.to_string())?;
    }
    let mut child = active.child;
    let _ = child.wait().await;
    let out = String::from_utf8_lossy(&buf);
    let base = path.trim_end_matches('/');
    let entries: Vec<FsEntry> = out
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let is_dir = line.ends_with('/');
            let name = line.trim_end_matches('/');
            FsEntry { name: name.to_string(), is_dir, path: format!("{base}/{name}") }
        })
        .collect();
    Ok(entries)
}

#[tauri::command]
pub async fn ssh_fs_read(host: String, port: Option<u16>, path: String) -> Result<String, String> {
    const BYTE_CAP: usize = 512 * 1024;
    if path.is_empty() {
        return Err("path required".into());
    }
    let remote = format!("cat -- {}", sh_quote(&path));
    let mut args = ssh_transport_args(&host, port);
    args.push(remote);
    let mut active = LocalSpawner
        .spawn(CommandSpec::new("ssh").args(args))
        .await
        .map_err(|e| format!("ssh failed: {e}"))?;
    let mut buf = Vec::new();
    {
        use tokio::io::AsyncReadExt;
        tokio::time::timeout(std::time::Duration::from_secs(20), active.stdout.read_to_end(&mut buf))
            .await
            .map_err(|_| "read timed out".to_string())?
            .map_err(|e| e.to_string())?;
    }
    let mut child = active.child;
    let _ = child.wait().await;
    buf.truncate(BYTE_CAP);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// ---------- Provider onboarding (native config formats) ----------

/// A stored custom provider, as shown in the UI. Secrets are never included —
/// only whether the entry carries an apiKey reference.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEntry {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api: String,
    pub key_configured: bool,
    pub model_count: usize,
}

fn provider_entries(harness: HarnessParam) -> Result<Vec<ProviderEntry>, String> {
    let h = by_id(match harness {
        HarnessParam::Pi => HarnessId::Pi,
        HarnessParam::Omp => HarnessId::Omp,
    });
    let path = h.models_config_path();
    let providers = match harness {
        HarnessParam::Pi => harness::config::read_pi_models(&path),
        HarnessParam::Omp => harness::config::read_omp_providers(&path),
    }
    .map_err(|e| e.to_string())?;
    Ok(providers
        .iter()
        .map(|(id, v)| {
            let models = v.get("models").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
            ProviderEntry {
                id: id.clone(),
                name: v.get("name").and_then(Value::as_str).unwrap_or(id).to_string(),
                base_url: v.get("baseUrl").and_then(Value::as_str).unwrap_or("").to_string(),
                api: v.get("api").and_then(Value::as_str).unwrap_or("openai-completions").to_string(),
                key_configured: v.get("apiKey").map(|k| !k.as_str().unwrap_or("").is_empty()).unwrap_or(false),
                model_count: models,
            }
        })
        .collect())
}

#[tauri::command]
pub fn providers_list(harness: HarnessParam) -> Result<Vec<ProviderEntry>, String> {
    provider_entries(harness)
}

#[tauri::command]
pub fn provider_upsert(harness: HarnessParam, id: String, mut config: Value) -> Result<(), String> {
    // Validation before touching the user's config file.
    let base_url = config.get("baseUrl").and_then(Value::as_str).unwrap_or("");
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("baseUrl must be an http(s) URL".into());
    }
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("provider id may only contain letters, digits, '-' and '_'".into());
    }
    if let Some(obj) = config.as_object_mut() {
        obj.entry("api").or_insert(Value::String("openai-completions".into()));
        if !obj.contains_key("models") {
            return Err("config must include at least one model".into());
        }
    }
    let h = by_id(match harness {
        HarnessParam::Pi => HarnessId::Pi,
        HarnessParam::Omp => HarnessId::Omp,
    });
    let path = h.models_config_path();
    let result = match harness {
        HarnessParam::Pi => harness::config::upsert_pi_provider(&path, &id, config),
        HarnessParam::Omp => harness::config::upsert_omp_provider(&path, &id, config),
    };
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_remove(harness: HarnessParam, id: String) -> Result<(), String> {
    let h = by_id(match harness {
        HarnessParam::Pi => HarnessId::Pi,
        HarnessParam::Omp => HarnessId::Omp,
    });
    let path = h.models_config_path();
    let result = match harness {
        HarnessParam::Pi => harness::config::remove_pi_provider(&path, &id),
        HarnessParam::Omp => harness::config::remove_omp_provider(&path, &id),
    };
    result.map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub ok: bool,
    pub model_count: Option<usize>,
    pub error: Option<String>,
}

/// Probes an endpoint's `/models` route. `api_key` follows the harnesses'
/// native value resolution: `$ENV_VAR` interpolation, `!command` execution,
/// or a literal key.
#[tauri::command]
pub async fn provider_test(base_url: String, api_key: Option<String>) -> Result<ProviderTestResult, String> {
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("baseUrl must be an http(s) URL".into());
    }
    let resolved = match api_key.as_deref() {
        None | Some("") => None,
        Some(key) if key.starts_with('!') => {
            let out = tokio::process::Command::new("sh")
                .arg("-c")
                .arg(&key[1..])
                .output()
                .await
                .map_err(|e| e.to_string())?;
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Some(s)
        }
        Some(key) if key.starts_with('$') => {
            let name = key.trim_start_matches('$').trim_start_matches('{').trim_end_matches('}');
            std::env::var(name).ok()
        }
        Some(key) => Some(key.to_string()),
    };

    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args(["-s", "-m", "8", "-w", "\n%{http_code}", &url]);
    if let Some(key) = &resolved {
        cmd.arg("-H").arg(format!("Authorization: Bearer {key}"));
    }
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let (body, code) = stdout
        .rsplit_once('\n')
        .map(|(b, c)| (b.to_string(), c.trim().to_string()))
        .unwrap_or((stdout.into_owned(), "0".into()));
    if code != "200" {
        return Ok(ProviderTestResult {
            ok: false,
            model_count: None,
            error: Some(format!("HTTP {code}")),
        });
    }
    let parsed: Result<Value, _> = serde_json::from_str(body.trim());
    let count = match parsed {
        Ok(v) => v
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| v.as_array())
            .map(|a| a.len()),
        Err(_) => None,
    };
    Ok(ProviderTestResult {
        ok: count.map(|c| c > 0).unwrap_or(true),
        model_count: count,
        error: if count.is_none() { Some("response did not contain a models list".into()) } else { None },
    })
}

/// Sends a correlation-tracked command; resolves with the raw response object.
#[tauri::command]
pub async fn runtime_request(state: State<'_, AppState>, runtime_id: String, command: Value) -> Result<Value, String> {
    let entry = state_runtimes(&state).get(&runtime_id).cloned().ok_or("unknown runtime")?;
    entry.client.request(command).await.map_err(|e| e.to_string())
}

/// Fire-and-forget command (extension_ui responses, abort during teardown…).
#[tauri::command]
pub fn runtime_send(state: State<'_, AppState>, runtime_id: String, command: Value) -> Result<(), String> {
    let entry = state_runtimes(&state).get(&runtime_id).cloned().ok_or("unknown runtime")?;
    entry.client.send(command).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn runtime_kill(state: State<'_, AppState>, runtime_id: String) -> Result<(), String> {
    let entry = state_runtimes(&state).get(&runtime_id).cloned().ok_or("unknown runtime")?;
    entry.client.kill().await;
    Ok(())
}

#[tauri::command]
pub fn runtimes_list(state: State<'_, AppState>) -> Vec<RuntimeInfo> {
    state_runtimes(&state)
        .values()
        .map(|e| RuntimeInfo {
            id: e.id.clone(),
            harness: format!("{:?}", e.harness_id).to_lowercase(),
            pid: e.client.pid(),
            exited: e.client.has_exited(),
            host: e.host.clone(),
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarnessParam {
    Pi,
    Omp,
}

#[tauri::command]
pub fn sessions_list(harness: HarnessParam) -> Vec<harness::SessionSummary> {
    let h = by_id(match harness {
        HarnessParam::Pi => HarnessId::Pi,
        HarnessParam::Omp => HarnessId::Omp,
    });
    harness::sessions::scan(&*h).unwrap_or_default()
}

#[tauri::command]
pub async fn models_list(harness: HarnessParam) -> Result<Vec<harness::ModelInfo>, String> {
    let h = by_id(match harness {
        HarnessParam::Pi => HarnessId::Pi,
        HarnessParam::Omp => HarnessId::Omp,
    });
    harness::models::list_models_local(h).await.map_err(|e| e.to_string())
}

// ---------- SSH host registry + reachability ----------

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

#[tauri::command]
pub fn ssh_hosts_list(app: tauri::AppHandle) -> Vec<ssh::HostEntry> {
    ssh::load_registry(&data_dir(&app)).hosts
}

/// One registered host by alias. Shared with the terminal, which reaches a
/// remote the same way the agent does.
pub fn ssh_host(app: &tauri::AppHandle, alias: &str) -> Result<ssh::HostEntry, String> {
    ssh::load_registry(&data_dir(app))
        .hosts
        .into_iter()
        .find(|h| h.alias == alias)
        .ok_or_else(|| format!("unknown ssh host: {alias}"))
}

#[tauri::command]
pub fn ssh_host_add(app: tauri::AppHandle, alias: String, destination: String, port: Option<u16>) -> Result<(), String> {
    ssh::validate_host(&alias, &destination).map_err(|e| e.to_string())?;
    let mut registry = ssh::load_registry(&data_dir(&app));
    registry.hosts.retain(|h| h.alias != alias);
    registry.hosts.push(ssh::HostEntry { alias, destination, port, extra_args: Vec::new() });
    ssh::save_registry(&data_dir(&app), &registry).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_host_remove(app: tauri::AppHandle, alias: String) -> Result<(), String> {
    let mut registry = ssh::load_registry(&data_dir(&app));
    registry.hosts.retain(|h| h.alias != alias);
    ssh::save_registry(&data_dir(&app), &registry).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProbe {
    pub reachable: bool,
    pub detail: String,
}

/// Probes a host with an echo over ssh (BatchMode — keys/agent only).
#[tauri::command]
pub async fn ssh_host_test(host: String, port: Option<u16>) -> HostProbe {
    let spec = ssh::probe_spec(&host, port);
    match LocalSpawner.spawn(spec).await {
        Ok(mut active) => {
            use tokio::io::AsyncReadExt;
            let mut out = String::new();
            let _ = active.stdout.read_to_string(&mut out).await;
            let _ = active.child.wait().await;
            let ok = out.trim() == "pong";
            HostProbe {
                reachable: ok,
                detail: if ok { "connected".into() } else { "no pong — check host, key auth (BatchMode), and remote sshd".into() },
            }
        }
        Err(e) => HostProbe { reachable: false, detail: e.to_string() },
    }
}

#[cfg(test)]
mod tests {
    use super::{create_scratch_session, encode_rgba_png, expand_scratch_home};
    use std::path::{Path, PathBuf};

    #[test]
    fn encodes_clipboard_pixels_as_png() {
        let encoded = encode_rgba_png(&[255, 0, 0, 255], 1, 1).expect("valid PNG");

        assert_eq!(&encoded[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn creates_unique_scratch_session_directories() {
        let root = std::env::temp_dir().join(format!("pi-desktop-scratch-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create test scratch root");

        let first = create_scratch_session(&root).expect("create first scratch session");
        let second = create_scratch_session(&root).expect("create second scratch session");

        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(root.as_path()));
        assert_eq!(second.parent(), Some(root.as_path()));
        std::fs::remove_dir_all(root).expect("remove test scratch root");
    }

    #[test]
    fn expands_home_relative_scratch_paths() {
        let home = Path::new("/home/tester");

        assert_eq!(expand_scratch_home("~", home), PathBuf::from("/home/tester"));
        assert_eq!(expand_scratch_home("~/scratch", home), PathBuf::from("/home/tester/scratch"));
        assert_eq!(expand_scratch_home("~\\scratch", home), PathBuf::from("/home/tester/scratch"));
        assert_eq!(expand_scratch_home("/tmp/scratch", home), PathBuf::from("/tmp/scratch"));
    }
}
