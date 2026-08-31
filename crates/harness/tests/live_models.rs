//! Live diagnostics for the model catalog, session resume, and slash commands.

use std::sync::Arc;
use std::time::Duration;

use harness::client::RpcClient;
use harness::harness::{Harness, Omp, Pi};

#[tokio::test]
#[ignore = "live diagnostic"]
async fn omp_catalog_has_models() {
    let models = harness::models::list_models_local(Arc::new(Omp))
        .await
        .map_err(|e| format!("omp catalog failed: {e}"))
        .unwrap();
    println!("omp models: {}", models.len());
    for m in models.iter().take(5) {
        println!("  {}/{}", m.provider, m.id);
    }
    assert!(!models.is_empty(), "omp catalog must not be empty");
}

#[tokio::test]
#[ignore = "live diagnostic"]
async fn omp_resume_replays_history() {
    let h = Arc::new(Omp);
    let sessions = harness::sessions::scan(&*h).unwrap();
    let newest = sessions.first().ok_or("no omp sessions on this machine").unwrap();
    println!("resuming: {}", newest.path.display());

    let spec = Omp.spawn_spec(&harness::spec::SpawnOptions {
        cwd: Some(std::path::PathBuf::from(&newest.cwd)),
        resume_path: Some(newest.path.clone()),
        ..Default::default()
    });
    let client = RpcClient::spawn(h, &harness::LocalSpawner, spec)
        .await
        .map_err(|e| format!("spawn failed: {e}"))
        .unwrap();
    let _rx = client.subscribe();

    // The client answers ready→negotiate on its own; give it a beat, then
    // request under protocol v2 so the oversized response arrives chunked.
    tokio::time::sleep(Duration::from_millis(700)).await;

    let resp = client
        .request_timeout(harness::cmd::get_messages(0), Duration::from_secs(90))
        .await
        .map_err(|e| {
            format!(
                "get_messages failed: {e} | stderr: {:?} | exited: {}",
                client.stderr_tail(),
                client.has_exited()
            )
        })
        .unwrap();
    client.kill().await;

    let success = resp.get("success").and_then(|s| s.as_bool()).unwrap_or(false);
    let count = resp
        .pointer("/data/messages")
        .and_then(|m| m.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    println!("get_messages success: {success}, messages: {count}");
    if !success {
        println!("error: {:?}", resp.get("error"));
    }
    assert!(success, "get_messages must succeed under v2 chunking");
    assert!(count > 0, "resume must surface history");
}

#[tokio::test]
#[ignore = "live diagnostic"]
async fn omp_get_commands_lists_slash_commands() {
    let cwd = std::env::temp_dir().join("harness-cmds-test");
    std::fs::create_dir_all(&cwd).unwrap();
    let spec = Omp.spawn_spec(&harness::spec::SpawnOptions {
        cwd: Some(cwd),
        no_session: true,
        ..Default::default()
    });
    let client = RpcClient::spawn(Arc::new(Omp), &harness::LocalSpawner, spec).await.unwrap();
    let mut rx = client.subscribe();
    let resp = client
        .request_timeout(harness::cmd::get_state(0), Duration::from_secs(10))
        .await
        .unwrap();
    println!("state ok: {}", resp["success"]);
    let mut found = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline && found == 0 {
        if let Ok(Ok(ev)) = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
            if ev.kind() == "available_commands_update" {
                found = ev
                    .value()
                    .get("commands")
                    .and_then(|c| c.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
            }
        }
    }
    client.kill().await;
    println!("slash commands available: {found}");
    assert!(found > 0, "available_commands_update must carry commands");
}

#[allow(dead_code)]
fn _keep_imports(_: Arc<Pi>) {}
