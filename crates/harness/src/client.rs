//! Transport-agnostic JSONL RPC client for pi/omp agent runtimes.
//!
//! Lifecycle: `Spawner` → [`RpcClient::spawn`] → `request`/`subscribe` →
//! drop (closes stdin, agent exits) or [`RpcClient::kill`].
//!
//! - Requests carry monotonic numeric ids; responses are correlated by id.
//! - Events (everything else) broadcast to subscribers after per-harness
//!   normalization. Responses for unknown/expired ids are also broadcast.
//! - omp runtimes get the protocol-v2 handshake (answered on the pushed
//!   `ready` frame) and base64 `rpc_chunk` reassembly — transparent to callers.
//! - A slow consumer loses events (`broadcast::error::Lagged`); callers
//!   recover via `get_messages` + `get_state` replay. This matches the
//!   harnesses' own replay story and keeps memory bounded.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc, oneshot, watch, Notify};
use tokio::time::Duration;

use crate::error::{Error, Result};
use crate::events::Event;
use crate::framing::{ChunkReassembler, LineReader};
use crate::harness::Harness;
use crate::spec::{ActiveProcess, CommandSpec, Spawner};

pub const DEFAULT_MAX_FRAME_BYTES: u64 = 16 * 1024 * 1024;
pub const DEFAULT_MAX_REASSEMBLED_BYTES: u64 = 64 * 1024 * 1024;
const EVENT_BUFFER: usize = 1024;
const STDERR_TAIL_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    /// Process exit code, if it exited normally.
    pub code: Option<i32>,
    /// Protocol failure or kill marker; `None` for a clean child exit.
    pub error: Option<String>,
}

impl ExitInfo {
    fn failed(error: impl Into<String>) -> Self {
        Self { code: None, error: Some(error.into()) }
    }
}

#[derive(Debug, Clone)]
pub struct ClientOptions {
    pub max_frame_bytes: u64,
    pub max_reassembled_bytes: u64,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self { max_frame_bytes: DEFAULT_MAX_FRAME_BYTES, max_reassembled_bytes: DEFAULT_MAX_REASSEMBLED_BYTES }
    }
}

pub struct RpcClient {
    harness: Arc<dyn Harness>,
    cmd_tx: mpsc::UnboundedSender<Value>,
    kill: Arc<Notify>,
    /// Resolves once the protocol handshake completed (immediately for
    /// harnesses without one). Requests wait on it so their frames are always
    /// processed under the negotiated protocol version.
    negotiated: watch::Receiver<bool>,
    events_tx: broadcast::Sender<Event>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    exit_rx: watch::Receiver<Option<ExitInfo>>,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
    pid: Option<u32>,
}

impl RpcClient {
    /// Spawns `spec` via `spawner` and attaches the client loop.
    pub async fn spawn(harness: Arc<dyn Harness>, spawner: &dyn Spawner, spec: CommandSpec) -> Result<Self> {
        let active = spawner.spawn(spec).await?;
        Self::connect(harness, active, ClientOptions::default())
    }

    /// Attaches to an already-spawned process.
    pub fn connect(harness: Arc<dyn Harness>, active: ActiveProcess, opts: ClientOptions) -> Result<Self> {
        let pid = active.child.id();

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<Value>();
        let (events_tx, _) = broadcast::channel(EVENT_BUFFER);
        let (exit_tx, exit_rx) = watch::channel(None::<ExitInfo>);
        let (negotiated_tx, negotiated_rx) = watch::channel(!harness.expects_ready_frame());
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let stderr_tail = Arc::new(Mutex::new(Vec::with_capacity(1024)));
        let kill = Arc::new(Notify::new());

        tokio::spawn(writer_task(cmd_rx, active.stdin));
        tokio::spawn(stderr_task(active.stderr, stderr_tail.clone()));

        let kill_for_supervisor = kill.clone();
        tokio::spawn(supervisor_task(active.child, kill_for_supervisor, exit_tx.clone()));

        let pending_for_reader = pending.clone();
        let harness_for_reader = harness.clone();
        let events_for_reader = events_tx.clone();
        let cmd_for_reader = cmd_tx.clone();
        let negotiated_tx_reader = if harness.expects_ready_frame() { Some(negotiated_tx.clone()) } else { None };
        drop(negotiated_tx);
        tokio::spawn(async move {
            let fatal = reader_task(
                active.stdout,
                harness_for_reader,
                pending_for_reader.clone(),
                events_for_reader,
                cmd_for_reader,
                negotiated_tx_reader,
                opts,
            )
            .await;
            // Fail every in-flight request immediately; receivers map the send
            // error to ProcessExited. The supervisor reports the true exit code.
            pending_for_reader.lock().expect("pending lock").clear();
            if let Some(e) = fatal {
                let _ = exit_tx.send(Some(ExitInfo::failed(e)));
            }
        });

        Ok(Self { harness, cmd_tx, kill, negotiated: negotiated_rx, events_tx, next_id: AtomicU64::new(1), pending, exit_rx, stderr_tail, pid })
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Broadcast stream of normalized harness events.
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events_tx.subscribe()
    }

    /// Watch channel resolving to `Some(ExitInfo)` once the runtime exits.
    pub fn exit(&self) -> watch::Receiver<Option<ExitInfo>> {
        self.exit_rx.clone()
    }

    pub fn has_exited(&self) -> bool {
        self.exit_rx.borrow().is_some()
    }

    /// Last stderr bytes emitted by the runtime (diagnostics on failure).
    pub fn stderr_tail(&self) -> String {
        let t = self.stderr_tail.lock().expect("stderr lock");
        String::from_utf8_lossy(&t).into_owned()
    }

    /// Assigns an id, applies harness translation, registers correlation, sends.
    /// Resolves with the raw response object.
    pub async fn request(&self, mut cmd: Value) -> Result<Value> {
        if self.has_exited() {
            return Err(self.exit_error());
        }
        // Protocol ordering: never write a command before the v2 negotiation
        // lands — omp rejects oversized v1 responses instead of chunking them.
        let mut negotiated = self.negotiated.clone();
        if !*negotiated.borrow() {
            negotiated.changed().await.map_err(|_| self.exit_error())?;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        cmd["id"] = Value::from(id);
        self.harness.translate_command(&mut cmd);
        let (rtx, rrx) = oneshot::channel();
        self.pending.lock().expect("pending lock").insert(id, rtx);
        if self.cmd_tx.send(cmd).is_err() {
            self.pending.lock().expect("pending lock").remove(&id);
            return Err(self.exit_error());
        }
        match rrx.await {
            Ok(resp) => Ok(resp),
            Err(_) => Err(self.exit_error()),
        }
    }

    /// [`RpcClient::request`] with a timeout.
    pub async fn request_timeout(&self, cmd: Value, timeout: Duration) -> Result<Value> {
        match tokio::time::timeout(timeout, self.request(cmd)).await {
            Ok(r) => r,
            Err(_) => Err(Error::Other("request timed out".into())),
        }
    }

    /// Fire-and-forget send (no id, no correlation).
    pub fn send(&self, cmd: Value) -> Result<()> {
        self.cmd_tx.send(cmd).map_err(|_| self.exit_error())
    }

    /// Answers an `extension_ui_request` (dialogs and omp tool-approval prompts).
    pub fn respond_extension_ui(&self, request_id: &str, method: &str, payload: Value) -> Result<()> {
        self.send(json!({ "type": "extension_ui_response", "id": request_id, "method": method, "payload": payload }))
    }

    /// Hard-kills the runtime.
    pub async fn kill(&self) {
        self.kill.notify_one();
        let mut exit = self.exit_rx.clone();
        while exit.borrow().is_none() {
            if exit.changed().await.is_err() {
                break;
            }
        }
    }

    fn exit_error(&self) -> Error {
        match self.exit_rx.borrow().clone() {
            Some(info) => Error::ProcessExited {
                status: info
                    .code
                    .map(|c| format!("exit code {c}"))
                    .or_else(|| info.error.clone().map(|e| format!("protocol failure: {e}")))
                    .unwrap_or_else(|| "exited".into()),
            },
            None => Error::ProcessExited { status: "client closed".into() },
        }
    }
}

async fn writer_task(mut rx: mpsc::UnboundedReceiver<Value>, mut stdin: tokio::process::ChildStdin) {
    while let Some(cmd) = rx.recv().await {
        let mut line = match serde_json::to_string(&cmd) {
            Ok(l) => l,
            Err(e) => {
                tracing::error!(%e, "command not serializable; dropping");
                continue;
            }
        };
        line.push('\n');
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
}

async fn stderr_task(mut stderr: tokio::process::ChildStderr, tail: Arc<Mutex<Vec<u8>>>) {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 4096];
    loop {
        match stderr.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut t = tail.lock().expect("stderr lock");
                t.extend_from_slice(&buf[..n]);
                let excess = t.len().saturating_sub(STDERR_TAIL_BYTES);
                if excess > 0 {
                    t.drain(..excess);
                }
            }
        }
    }
}

async fn supervisor_task(mut child: tokio::process::Child, kill: Arc<Notify>, exit_tx: watch::Sender<Option<ExitInfo>>) {
    let info = tokio::select! {
        biased;
        _ = kill.notified() => {
            let _ = child.start_kill();
            match child.wait().await {
                Ok(s) => ExitInfo { code: s.code(), error: Some("killed".into()) },
                Err(e) => ExitInfo::failed(e.to_string()),
            }
        }
        status = child.wait() => match status {
            Ok(s) => ExitInfo { code: s.code(), error: None },
            Err(e) => ExitInfo::failed(e.to_string()),
        },
    };
    let _ = exit_tx.send(Some(info));
}

/// Reads frames, dispatches responses and events. Returns a fatal-error
/// description if the protocol or pipe broke; a clean EOF returns `None`.
async fn reader_task(
    stdout: tokio::process::ChildStdout,
    harness: Arc<dyn Harness>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    events_tx: broadcast::Sender<Event>,
    cmd_tx: mpsc::UnboundedSender<Value>,
    negotiated_tx: Option<watch::Sender<bool>>,
    opts: ClientOptions,
) -> Option<String> {
    let mut reader = LineReader::new(stdout);
    let mut chunks = ChunkReassembler::new(opts.max_reassembled_bytes);
    let needs_reassembly = harness.needs_chunk_reassembly();

    loop {
        let line = match reader.next_line(opts.max_frame_bytes).await {
            Ok(Some(l)) => l,
            Ok(None) => return None,
            Err(e) => return Some(e.to_string()),
        };
        let mut value: Value = match serde_json::from_slice(&line) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(%e, bytes = line.len(), "undecodable frame; skipping");
                continue;
            }
        };

        // omp protocol v2: oversized frames arrive as base64 chunk sequences.
        if needs_reassembly && value.get("type").and_then(Value::as_str) == Some("rpc_chunk") {
            let (id, index, count, data) = chunk_fields(&value);
            match chunks.feed(id, index, count, data) {
                Ok(Some(frame)) => match serde_json::from_slice::<Value>(&frame) {
                    Ok(v) => value = v,
                    Err(e) => return Some(e.to_string()),
                },
                Ok(None) => continue, // more chunks to come
                Err(e) => return Some(e.to_string()),
            }
        }

        // Handshake: omp pushes `ready`; answer with the v2 negotiation.
        if harness.expects_ready_frame() && value.get("type").and_then(Value::as_str) == Some("ready") {
            let negotiate = json!({ "type": "negotiate_protocol", "protocolVersion": 2 });
            if cmd_tx.send(negotiate).is_err() {
                return Some("writer closed during handshake".into());
            }
            if let Some(tx) = &negotiated_tx {
                let _ = tx.send(true);
            }
            if let Some(tx) = negotiated_tx.as_ref() {
                let _ = tx.send(true);
            }
        }

        // Response correlation.
        if value.get("type").and_then(Value::as_str) == Some("response") {
            if let Some(id) = value.get("id").and_then(Value::as_u64) {
                if let Some(tx) = pending.lock().expect("pending lock").remove(&id) {
                    let _ = tx.send(value);
                    continue;
                }
            }
        }

        // Normalization + broadcast.
        let mut ev = value;
        if harness.normalize_event(&mut ev) == crate::harness::EventAction::Swallow {
            continue;
        }
        let _ = events_tx.send(Event::from_value(ev));
    }
}

fn chunk_fields(value: &Value) -> (u64, u64, u64, &str) {
    (
        value.get("chunkId").and_then(Value::as_u64).unwrap_or(0),
        value.get("index").and_then(Value::as_u64).unwrap_or(0),
        value.get("count").and_then(Value::as_u64).unwrap_or(0),
        value.get("data").and_then(Value::as_str).unwrap_or(""),
    )
}
