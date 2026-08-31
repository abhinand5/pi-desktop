//! End-to-end integration tests: the RPC client against a scripted fake
//! agent, plus golden replay of live-captured pi/omp sessions.
//!
//! These run the real tokio pipes end-to-end — spawn, framing, handshake,
//! correlation, normalization, event broadcast.

use std::sync::Arc;
use std::time::Duration;

use harness::client::RpcClient;
use harness::events::Event;
use harness::harness::{Omp, Pi};
use harness::spec::{CommandSpec, LocalSpawner, Spawner};

const TIMEOUT: Duration = Duration::from_secs(10);

fn fake_agent(mode: &str) -> CommandSpec {
    CommandSpec::new(env!("CARGO_BIN_EXE_fake-agent")).arg(mode)
}

async fn collect_until(
    rx: &mut tokio::sync::broadcast::Receiver<Event>,
    done: impl Fn(&Event) -> bool,
) -> Vec<Event> {
    let mut events = Vec::new();
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        assert!(tokio::time::Instant::now() < deadline, "timed out collecting events");
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Ok(ev)) => {
                let finished = done(&ev);
                events.push(ev);
                if finished {
                    return events;
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                panic!("event consumer lagged by {n} — test is too slow for its own stream");
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                panic!("event stream closed before the expected terminal event");
            }
            Err(_) => panic!("no event within 2s while waiting for terminal event"),
        }
    }
}

fn text_of(events: &[Event]) -> String {
    events.iter().filter_map(|e| e.assistant_text_delta()).collect()
}

#[tokio::test]
async fn omp_end_to_end_with_handshake() {
    let client = RpcClient::spawn(
        Arc::new(Omp),
        &LocalSpawner,
        fake_agent("omp"),
    )
    .await
    .unwrap();
    let mut rx = client.subscribe();

    // get_state round-trip through response correlation.
    let state = client.request(harness::cmd::get_state(0)).await.unwrap();
    assert_eq!(state["success"], true);
    assert_eq!(state["data"]["sessionId"], "fake");

    // Prompt turn streams deltas and terminates.
    let resp = client.request(harness::cmd::prompt(0, "say ok")).await.unwrap();
    assert_eq!(resp["success"], true);
    let events = collect_until(&mut rx, |e| e.is_agent_end()).await;
    assert_eq!(text_of(&events), "ok");
    assert!(events.iter().any(|e| e.kind() == "agent_start"));
    assert!(events.iter().any(|e| e.kind() == "turn_end"));

    // Handshake actually happened: the fake agent confirms post-negotiate.
    assert!(events.iter().any(|e| e.kind() == "notice" && e.value()["text"] == "negotiated:v2"));
    // omp's non-terminal agent_end was swallowed by the adapter, so exactly
    // one agent_end reaches the subscriber (the terminal one).
    assert_eq!(events.iter().filter(|e| e.is_agent_end()).count(), 1);

    client.kill().await;
}

#[tokio::test]
async fn omp_rejects_prompt_before_negotiate() {
    // The fake omp exits(3) if a prompt lands before the handshake — proving
    // the client cannot skip it. We simulate a harness-less client by using
    // the PI adapter against the omp fake: no ready-frame handling, so the
    // negotiate never fires.
    let client = RpcClient::spawn(Arc::new(Pi), &LocalSpawner, fake_agent("omp")).await.unwrap();
    // The fake exits(3) before answering, so the request itself fails or
    // races — either way we only care about the exit code.
    let _ = client.request(harness::cmd::prompt(0, "too early")).await;
    let mut exit = client.exit();
    // Wait for exit; the fake must have died with code 3.
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    while exit.borrow().is_none() {
        assert!(tokio::time::Instant::now() < deadline, "fake omp never exited");
        tokio::time::timeout(Duration::from_secs(1), exit.changed()).await.expect("exit wait").ok();
    }
    assert_eq!(exit.borrow().as_ref().and_then(|i| i.code), Some(3), "prompt before negotiate must violate the omp contract");
}

#[tokio::test]
async fn oversized_frame_is_a_fatal_protocol_error() {
    // Explicit 1 MiB cap; the fake emits a 2 MiB line.
    let active = LocalSpawner
        .spawn(fake_agent("big"))
        .await
        .unwrap();
    let client = RpcClient::connect(
        Arc::new(Pi),
        active,
        harness::client::ClientOptions { max_frame_bytes: 1024 * 1024, ..Default::default() },
    )
    .unwrap();
    let mut exit = client.exit();
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    while exit.borrow().is_none() {
        assert!(tokio::time::Instant::now() < deadline, "client should die on oversized frame");
        let _ = tokio::time::timeout(Duration::from_millis(500), exit.changed()).await;
    }
    let info = exit.borrow().clone().unwrap();
    assert!(info.error.as_deref().unwrap_or("").contains("frame exceeds"), "got {info:?}");
    // A request after death fails instead of hanging.
    assert!(client.request(harness::cmd::get_state(0)).await.is_err());
}

#[tokio::test]
async fn chunked_frames_are_reassembled() {
    let client = RpcClient::spawn(Arc::new(Omp), &LocalSpawner, fake_agent("chunked")).await.unwrap();
    let mut rx = client.subscribe();
    let events = collect_until(&mut rx, |e| e.is_agent_start()).await;
    let ev = events.iter().find(|e| e.is_agent_start()).expect("reassembled event");
    let note = ev.value()["note"].as_str().unwrap_or("");
    assert_eq!(note.len(), 1_500_000, "reassembled payload must be intact");
    client.kill().await;
}

#[tokio::test]
async fn request_after_exit_fails_fast() {
    let client = RpcClient::spawn(Arc::new(Pi), &LocalSpawner, fake_agent("pi")).await.unwrap();
    client.kill().await;
    assert!(client.has_exited());
    let err = client.request(harness::cmd::get_state(0)).await.unwrap_err();
    assert!(matches!(err, harness::Error::ProcessExited { .. }));
}

// ---------- Golden replays: real captured pi/omp output ----------

fn fixture(name: &str) -> CommandSpec {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    CommandSpec::new("cat").arg(path.to_string_lossy().into_owned())
}

#[tokio::test]
async fn golden_pi_stream_success() {
    // Documented-shape 0.84 stream: response, lifecycle, streaming deltas,
    // usage on the final message, agent_settled terminator.
    let client =
        RpcClient::spawn(Arc::new(Pi), &LocalSpawner, fixture("pi-stream-success.jsonl")).await.unwrap();
    let mut rx = client.subscribe();
    let events = collect_until(&mut rx, |e| e.is_agent_settled()).await;
    let kinds: Vec<&str> = events.iter().map(|e| e.kind()).collect();
    assert_eq!(
        kinds,
        vec!["response", "agent_start", "turn_start", "message_start", "message_end", "message_start", "message_update", "message_update", "message_update", "message_end", "turn_end", "agent_end", "agent_settled"]
    );
    let assistant = events.iter().find_map(|e| e.assistant_message_end()).expect("assistant message_end");
    assert_eq!(assistant["stopReason"], "stop");
    assert_eq!(assistant["usage"]["totalTokens"], 13);
    client.kill().await;
}

#[tokio::test]
async fn golden_pi_auth_failures_surface_provider_and_message() {
    // Both captured live: expired OAuth refresh on two different providers.
    // This is the exact shape the UI maps to a "re-authenticate" action.
    for (file, provider, fragment) in [
        ("pi-auth-anthropic-failure.jsonl", "anthropic", "OAuth refresh failed"),
        ("pi-auth-codex-failure.jsonl", "openai-codex", "token refresh failed"),
    ] {
        let client = RpcClient::spawn(Arc::new(Pi), &LocalSpawner, fixture(file)).await.unwrap();
        let mut rx = client.subscribe();
        let events = collect_until(&mut rx, |e| e.is_agent_settled()).await;
        let failed = events
            .iter()
            .find(|e| e.stop_reason() == Some("error") && e.error_message().is_some())
            .unwrap_or_else(|| panic!("{file}: auth failure must surface"));
        assert!(failed.error_message().unwrap().contains(fragment), "{file}: {fragment}");
        assert_eq!(failed.message_provider(), Some(provider));
        client.kill().await;
    }
}

#[tokio::test]
async fn golden_omp_turn_replay() {
    // Captured live from omp 18.0.11: ready + negotiation + streaming deltas.
    // `cat file` ignores stdin, so the client's negotiate write is discarded.
    let client = RpcClient::spawn(Arc::new(Omp), &LocalSpawner, fixture("omp-turn.jsonl")).await.unwrap();
    let mut rx = client.subscribe();
    let events = collect_until(&mut rx, |e| e.is_agent_end()).await;
    assert_eq!(text_of(&events), "ok", "omp must stream text deltas");
    assert!(events.iter().any(|e| e.kind() == "ready"), "ready frame is forwarded to subscribers");
    // The user + assistant message pair, in order.
    let starts: Vec<&str> = events
        .iter()
        .filter(|e| e.kind() == "message_start")
        .filter_map(|e| e.value().pointer("/message/role").and_then(|r| r.as_str()))
        .collect();
    assert_eq!(starts, vec!["user", "assistant"]);
    client.kill().await;
}
