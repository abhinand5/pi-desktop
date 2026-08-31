//! Live end-to-end tests against the REAL omp/pi binaries on this machine.
//!
//! Ignored by default (requires binaries + configured provider credentials);
//! run explicitly with: cargo test -p harness --test live -- --ignored

use std::sync::Arc;
use std::time::Duration;

use harness::client::RpcClient;
use harness::events::Event;
use harness::harness::{Harness, Omp, Pi};
use harness::spec::{CommandSpec, LocalSpawner, SpawnOptions};

async fn run_turn(harness: Arc<dyn Harness>, spec: CommandSpec) -> Result<(String, bool), String> {
    let client = RpcClient::spawn(harness, &LocalSpawner, spec)
        .await
        .map_err(|e| e.to_string())?;
    let mut rx = client.subscribe();

    client
        .request_timeout(harness::cmd::prompt(0, "reply with exactly: ok"), Duration::from_secs(90))
        .await
        .map_err(|e| e.to_string())?;

    let mut text = String::new();
    let mut got_agent_end = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    loop {
        assert!(tokio::time::Instant::now() < deadline, "turn never settled");
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Ok(ev)) => {
                if let Some(d) = ev.assistant_text_delta() {
                    text.push_str(d);
                }
                if ev.is_agent_end() {
                    got_agent_end = true;
                    break;
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Err(_) => continue, // idle tick; loop until deadline
        }
    }
    client.kill().await;
    Ok((text, got_agent_end))
}

fn temp_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("harness-live-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
#[ignore = "live test: needs omp + provider credentials"]
async fn live_omp_turn() {
    let cwd = temp_dir();
    let spec = Omp.spawn_spec(&SpawnOptions {
        cwd: Some(cwd.clone()),
        no_session: true,
        ..Default::default()
    });
    let (text, ended) = run_turn(Arc::new(Omp), spec).await.map_err(|e| format!("{e}")).unwrap();
    assert!(ended, "agent_end must arrive");
    assert!(text.contains("ok"), "expected streamed reply, got: {text:?}");
    let _ = std::fs::remove_dir_all(cwd);
}

#[tokio::test]
#[ignore = "live test: needs pi + provider credentials"]
async fn live_pi_turn() {
    let cwd = temp_dir();
    let spec = Pi.spawn_spec(&SpawnOptions {
        cwd: Some(cwd.clone()),
        no_session: true,
        ..Default::default()
    });
    let (text, ended) = run_turn(Arc::new(Pi), spec).await.map_err(|e| format!("{e}")).unwrap();
    assert!(ended, "agent_end must arrive");
    assert!(text.contains("ok"), "expected streamed reply, got: {text:?}");
    let _ = std::fs::remove_dir_all(cwd);
}
