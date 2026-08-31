//! Model catalog fetching, normalized across harnesses.
//!
//! - pi: no JSON CLI — a short-lived RPC probe (`--mode rpc --no-session
//!   --offline`) answering `get_available_models` (gooey-pi-verified shape).
//! - omp: `omp models --json` one-shot stdout JSON.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::error::{Error, Result};
use crate::harness::{CatalogKind, Harness};
use crate::spec::{CatalogOptions, CommandSpec, Spawner};
use crate::{client::RpcClient, commands};

const CATALOG_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub provider: String,
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub api: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub input: Vec<String>,
    #[serde(default)]
    pub context_window: u64,
    #[serde(default)]
    pub max_tokens: u64,
    #[serde(default)]
    pub thinking_levels: Vec<String>,
    /// omp-only fuzzy selector (`omp --model <selector>`).
    #[serde(default)]
    pub selector: Option<String>,
}

/// Fetches the harness's model catalog via its native mechanism.
pub async fn list_models(harness: Arc<dyn Harness>, spawner: &dyn Spawner) -> Result<Vec<ModelInfo>> {
    let opts = CatalogOptions::default();
    match harness.catalog_kind() {
        CatalogKind::RpcProbe => {
            let probe_spec = harness.catalog_spec(&opts);
            let client = RpcClient::spawn(harness, spawner, probe_spec).await?;
            let result = async {
                let resp = client
                    .request_timeout(commands::get_available_models(0), CATALOG_TIMEOUT)
                    .await?;
                parse_rpc_models(resp.get("data").unwrap_or(&Value::Null))
            }
            .await;
            client.kill().await;
            result
        }
        CatalogKind::JsonCli => {
            let out = exec_json(spawner, harness.catalog_spec(&opts), opts.byte_cap).await?;
            parse_cli_models(&out)
        }
    }
}

/// Fetches the catalog using the default local spawner.
pub async fn list_models_local(harness: Arc<dyn Harness>) -> Result<Vec<ModelInfo>> {
    list_models(harness, &crate::spec::LocalSpawner).await
}

fn parse_rpc_models(data: &Value) -> Result<Vec<ModelInfo>> {
    let models =
        data.get("models").and_then(Value::as_array).ok_or_else(|| Error::UnexpectedResponse("models array missing".into()))?;
    Ok(models.iter().filter_map(parse_model_common).collect())
}

fn parse_cli_models(v: &Value) -> Result<Vec<ModelInfo>> {
    let models = v
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::UnexpectedResponse("omp models --json: models array missing".into()))?;
    Ok(models.iter().filter_map(parse_model_common).collect())
}

/// pi's canonical thinking-level ordering (off → max).
const LEVEL_ORDER: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

fn parse_model_common(m: &Value) -> Option<ModelInfo> {
    let provider = m.get("provider").and_then(Value::as_str)?.to_string();
    let id = m.get("id").and_then(Value::as_str)?.to_string();
    let thinking_levels = if let Some(map) = m.get("thinkingLevelMap").and_then(Value::as_object) {
        // pi: keys are pi levels; a null value marks an unsupported level.
        // HashMap order is unspecified — sort into pi's canonical order.
        let mut levels: Vec<String> =
            map.iter().filter(|(_, v)| !v.is_null()).map(|(k, _)| k.clone()).collect();
        levels.sort_by_key(|k| LEVEL_ORDER.iter().position(|l| l == k).unwrap_or(LEVEL_ORDER.len()));
        levels
    } else {
        m.get("thinking")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    };
    Some(ModelInfo {
        provider,
        id,
        name: m.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
        api: m.get("api").and_then(Value::as_str).unwrap_or_default().to_string(),
        base_url: m.get("baseUrl").and_then(Value::as_str).map(str::to_string),
        reasoning: m.get("reasoning").and_then(Value::as_bool).unwrap_or(false),
        input: m
            .get("input")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
        context_window: m.get("contextWindow").and_then(Value::as_u64).unwrap_or(0),
        max_tokens: m.get("maxTokens").and_then(Value::as_u64).unwrap_or(0),
        thinking_levels,
        selector: m.get("selector").and_then(Value::as_str).map(str::to_string),
    })
}

/// One-shot exec: run spec, capture bounded stdout, parse JSON. The child's
/// own exit closes the pipe; a hard timeout covers a hung child (kill_on_drop
/// reaps it when the guard drops on the error path).
async fn exec_json(spawner: &dyn Spawner, spec: CommandSpec, byte_cap: u64) -> Result<Value> {
    use tokio::io::AsyncReadExt;
    let active = spawner.spawn(spec).await?;
    let mut stdout = active.stdout;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let read = async {
        loop {
            let n = stdout.read(&mut chunk).await?;
            if n == 0 {
                break Ok(());
            }
            if buf.len() as u64 + n as u64 > byte_cap {
                break Err(Error::OversizedFrame { limit: byte_cap });
            }
            buf.extend_from_slice(&chunk[..n]);
        }
    };
    let outcome = tokio::time::timeout(CATALOG_TIMEOUT, read)
        .await
        .map_err(|_| Error::Other("catalog exec timed out".into()))?;
    outcome?;
    serde_json::from_slice(&buf).map_err(Error::Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_pi_rpc_catalog_shape() {
        let data = json!({
            "models": [
                {
                    "id": "claude-opus-4-8",
                    "name": "Claude Opus 4.8",
                    "api": "anthropic-messages",
                    "provider": "anthropic",
                    "baseUrl": "https://api.anthropic.com",
                    "reasoning": true,
                    "input": ["text", "image"],
                    "contextWindow": 200000,
                    "maxTokens": 32000,
                    "thinkingLevelMap": { "off": "off", "high": "high", "max": null }
                }
            ]
        });
        let out = parse_rpc_models(&data).unwrap();
        assert_eq!(out.len(), 1);
        let m = &out[0];
        assert_eq!(m.provider, "anthropic");
        assert_eq!(m.id, "claude-opus-4-8");
        assert!(m.reasoning);
        assert_eq!(m.context_window, 200000);
        assert_eq!(m.thinking_levels, vec!["off", "high"], "null levels are unsupported, dropped");
    }

    #[test]
    fn parses_omp_cli_catalog_shape() {
        let v = json!({
            "models": [
                {
                    "provider": "openrouter",
                    "id": "z-ai/glm-5.3-flash",
                    "selector": "openrouter/z-ai/glm-5.3-flash",
                    "name": "GLM 5.3 Flash",
                    "contextWindow": 128000,
                    "maxTokens": 8192,
                    "reasoning": false,
                    "thinking": null,
                    "input": ["text"]
                }
            ]
        });
        let out = parse_cli_models(&v).unwrap();
        assert_eq!(out[0].selector.as_deref(), Some("openrouter/z-ai/glm-5.3-flash"));
        assert_eq!(out[0].provider, "openrouter");
        assert!(out[0].thinking_levels.is_empty());
    }

    #[test]
    fn rejects_missing_models_array() {
        assert!(parse_rpc_models(&json!({})).is_err());
        assert!(parse_cli_models(&json!({ "models": "nope" })).is_err());
    }
}
