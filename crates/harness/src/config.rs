//! Provider configuration writers using each harness's NATIVE config formats.
//!
//! pi: `~/.pi/agent/models.json` — custom OpenAI-compatible providers
//! (`{"providers": {"<id>": {baseUrl, api, apiKey?, models: [...]}}}`).
//!
//! omp: `~/.omp/agent/models.yml` — SAME provider schema in YAML (verified
//! live: omp migrates models.json → models.yml once, then models.yml is the
//! live source of truth; later json edits are ignored).
//!
//! Both files support `"$ENV_VAR"` / `"!command"` / literal secret resolution
//! natively, so we write what the user typed and let the harness resolve it.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::error::Result;

/// Reads the existing `models.json` (empty structure when absent).
pub fn read_pi_models(path: &Path) -> Result<Map<String, Value>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let v: Value = serde_json::from_slice(&bytes)?;
            Ok(v.get("providers").and_then(Value::as_object).cloned().unwrap_or_default())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(e.into()),
    }
}

/// Inserts or replaces one provider entry, preserving all other content —
/// the file is manipulated as raw JSON so unknown fields survive round-trips.
pub fn upsert_pi_provider(path: &Path, id: &str, provider: Value) -> Result<()> {
    if !provider.is_object() {
        return Err(crate::error::Error::Other("provider entry must be an object".into()));
    }
    let mut providers = read_pi_models(path)?;
    providers.insert(id.to_string(), provider);
    write_pi_models(path, providers)
}

/// Removes one provider entry. Removing a missing id is a no-op.
pub fn remove_pi_provider(path: &Path, id: &str) -> Result<()> {
    let mut providers = read_pi_models(path)?;
    if providers.remove(id).is_none() {
        return Ok(());
    }
    write_pi_models(path, providers)
}

fn write_pi_models(path: &Path, providers: Map<String, Value>) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let doc = json!({ "providers": providers });
    // Atomic replace so a crash mid-write never truncates the user's config.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&doc)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

// ---------- omp models.yml ----------

/// Reads omp's `models.yml` providers (empty map when absent).
pub fn read_omp_providers(path: &Path) -> Result<Map<String, Value>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let doc: serde_yaml_ng::Value = serde_yaml_ng::from_slice(&bytes)?;
            let providers = doc
                .get("providers")
                .cloned()
                .unwrap_or(serde_yaml_ng::Value::Mapping(Default::default()));
            let json_value: Value =
                serde_json::to_value(&providers).map_err(|e| crate::error::Error::Other(e.to_string()))?;
            Ok(json_value.as_object().cloned().unwrap_or_default())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(e.into()),
    }
}

/// Inserts or replaces one provider in omp's `models.yml`, preserving all
/// other top-level keys and provider fields.
pub fn upsert_omp_provider(path: &Path, id: &str, provider: Value) -> Result<()> {
    if !provider.is_object() {
        return Err(crate::error::Error::Other("provider entry must be an object".into()));
    }
    let mut doc = read_omp_doc(path)?;
    let providers = doc
        .as_mapping_mut()
        .ok_or_else(|| crate::error::Error::Other("models.yml root must be a mapping".into()))?
        .entry(serde_yaml_ng::Value::String("providers".into()))
        .or_insert_with(|| serde_yaml_ng::Value::Mapping(Default::default()));
    if !providers.is_mapping() {
        return Err(crate::error::Error::Other("models.yml providers must be a mapping".into()));
    }
    let yaml_provider: serde_yaml_ng::Value =
        serde_json::from_value(provider).map_err(|e| crate::error::Error::Other(e.to_string()))?;
    providers
        .as_mapping_mut()
        .expect("checked mapping")
        .insert(serde_yaml_ng::Value::String(id.into()), yaml_provider);
    write_omp_doc(path, doc)
}

/// Removes one provider from omp's `models.yml`. Missing id is a no-op.
pub fn remove_omp_provider(path: &Path, id: &str) -> Result<()> {
    let mut doc = read_omp_doc(path)?;
    let removed = doc
        .as_mapping_mut()
        .and_then(|m| m.get_mut(serde_yaml_ng::Value::String("providers".into())))
        .and_then(|p| p.as_mapping_mut())
        .map(|p| p.remove(serde_yaml_ng::Value::String(id.into())).is_some())
        .unwrap_or(false);
    if removed {
        write_omp_doc(path, doc)?;
    }
    Ok(())
}

fn read_omp_doc(path: &Path) -> Result<serde_yaml_ng::Value> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_yaml_ng::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(serde_yaml_ng::Value::Mapping(Default::default()))
        }
        Err(e) => Err(e.into()),
    }
}

fn write_omp_doc(path: &Path, doc: serde_yaml_ng::Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("yml.tmp");
    std::fs::write(&tmp, serde_yaml_ng::to_string(&doc)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn omp_yml_upsert_preserves_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent").join("models.yml");
        upsert_omp_provider(
            &path,
            "testgw",
            json!({
                "name": "Test Gateway",
                "baseUrl": "http://127.0.0.1:9/v1",
                "api": "openai-completions",
                "apiKey": "$TEST_KEY",
                "models": [{ "id": "test-model", "reasoning": false }]
            }),
        )
        .unwrap();
        upsert_omp_provider(
            &path,
            "second",
            json!({ "baseUrl": "http://x/v1", "api": "openai-completions", "models": [{ "id": "m" }] }),
        )
        .unwrap();

        let providers = read_omp_providers(&path).unwrap();
        assert_eq!(providers.len(), 2);
        assert_eq!(providers["testgw"]["apiKey"], "$TEST_KEY");
        assert_eq!(providers["second"]["models"][0]["id"], "m");
    }

    #[test]
    fn omp_yml_remove_and_unknown_keys_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models.yml");
        std::fs::write(
            &path,
            "topLevel: keepme\nproviders:\n  a:\n    baseUrl: http://a/v1\n    api: openai-completions\n    models: []\n",
        )
        .unwrap();
        remove_omp_provider(&path, "a").unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("topLevel: keepme"), "unknown top-level keys must survive: {raw}");
        assert!(!raw.contains("baseUrl"), "removed provider must be gone");
        assert!(read_omp_providers(&path).unwrap().is_empty());
    }

    #[test]
    fn omp_yml_missing_file_reads_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_omp_providers(&dir.path().join("none.yml")).unwrap().is_empty());
    }
    #[test]
    fn upsert_creates_and_preserves_existing_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent").join("models.json");
        upsert_pi_provider(
            &path,
            "ollama",
            json!({
                "baseUrl": "http://localhost:11434/v1",
                "api": "openai-completions",
                "apiKey": "ollama",
                "compat": { "supportsDeveloperRole": false },
                "models": [{ "id": "llama3.1:8b" }]
            }),
        )
        .unwrap();
        upsert_pi_provider(
            &path,
            "gateway",
            json!({
                "baseUrl": "https://gw.corp/v1",
                "api": "openai-completions",
                "apiKey": "$CORP_KEY",
                "models": [{ "id": "gpt-x", "reasoning": true }]
            }),
        )
        .unwrap();

        let providers = read_pi_models(&path).unwrap();
        assert_eq!(providers.len(), 2);
        assert_eq!(providers["ollama"]["compat"]["supportsDeveloperRole"], false);
        assert_eq!(providers["gateway"]["apiKey"], "$CORP_KEY");
    }

    #[test]
    fn remove_is_noop_for_missing_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models.json");
        assert!(remove_pi_provider(&path, "ghost").is_ok());
        upsert_pi_provider(&path, "a", json!({ "baseUrl": "http://x", "api": "openai-completions", "models": [] })).unwrap();
        remove_pi_provider(&path, "a").unwrap();
        assert!(read_pi_models(&path).unwrap().is_empty());
    }

    #[test]
    fn rejects_non_object_provider() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models.json");
        assert!(upsert_pi_provider(&path, "x", json!(["nope"])).is_err());
    }

    #[test]
    fn read_is_empty_structure_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.json");
        assert!(read_pi_models(&path).unwrap().is_empty());
    }
}
