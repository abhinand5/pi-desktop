//! Typed builders for RPC commands. The client speaks one canonical command
//! vocabulary; per-harness translation (omp `fork`→`branch`) happens in the
//! harness adapter before serialization.

use serde_json::{json, Value};

/// Builds a command with a correlation id.
pub fn cmd(id: u64, r#type: &str) -> Value {
    json!({ "id": id, "type": r#type })
}

/// Send a user prompt. While the agent is streaming this is rejected unless a
/// `streamingBehavior` is present — prefer [`steer`]/[`follow_up`] then.
pub fn prompt(id: u64, message: &str) -> Value {
    json!({ "id": id, "type": "prompt", "message": message })
}

/// Prompt with explicit streaming behavior: `steer` | `followUp`.
pub fn prompt_with_behavior(id: u64, message: &str, behavior: &str) -> Value {
    json!({ "id": id, "type": "prompt", "message": message, "streamingBehavior": behavior })
}

/// Queue a steering message mid-run (delivered after the current tool round).
pub fn steer(id: u64, message: &str) -> Value {
    json!({ "id": id, "type": "steer", "message": message })
}

/// Queue a follow-up delivered once the agent goes idle.
pub fn follow_up(id: u64, message: &str) -> Value {
    json!({ "id": id, "type": "follow_up", "message": message })
}

pub fn abort(id: u64) -> Value {
    cmd(id, "abort")
}

pub fn get_state(id: u64) -> Value {
    cmd(id, "get_state")
}

pub fn get_messages(id: u64) -> Value {
    cmd(id, "get_messages")
}

pub fn get_available_models(id: u64) -> Value {
    cmd(id, "get_available_models")
}

pub fn get_session_stats(id: u64) -> Value {
    cmd(id, "get_session_stats")
}

/// `provider` + `modelId` are separate fields in both harnesses.
pub fn set_model(id: u64, provider: &str, model_id: &str) -> Value {
    json!({ "id": id, "type": "set_model", "provider": provider, "modelId": model_id })
}

/// Level: off|minimal|low|medium|high|xhigh|max.
pub fn set_thinking_level(id: u64, level: &str) -> Value {
    json!({ "id": id, "type": "set_thinking_level", "level": level })
}

pub fn new_session(id: u64) -> Value {
    cmd(id, "new_session")
}

pub fn compact(id: u64) -> Value {
    cmd(id, "compact")
}

pub fn set_session_name(id: u64, name: &str) -> Value {
    json!({ "id": id, "type": "set_session_name", "name": name })
}

/// Fork from a session tree entry (omp translates to `branch`).
pub fn fork(id: u64, entry_id: &str) -> Value {
    json!({ "id": id, "type": "fork", "entryId": entry_id })
}

pub fn get_fork_messages(id: u64, entry_id: &str) -> Value {
    json!({ "id": id, "type": "get_fork_messages", "entryId": entry_id })
}

/// Answers an `extension_ui_request` (dialogs AND omp tool-approval prompts).
/// Fire-and-forget: no correlation response is guaranteed.
pub fn extension_ui_response(request_id: &str, method: &str, payload: Value) -> Value {
    json!({ "type": "extension_ui_response", "id": request_id, "method": method, "payload": payload })
}

/// Parses a "provider/model" selector into its parts.
/// `"anthropic/claude-opus-4-8"` → `("anthropic", "claude-opus-4-8")`.
/// A bare `"claude-opus-4-8"` (no slash) returns `None` — callers pass it to
/// the harness's `--model` flag instead, which handles fuzzy matching.
pub fn split_model_selector(selector: &str) -> Option<(&str, &str)> {
    let (provider, model) = selector.split_once('/')?;
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    Some((provider, model))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::from_value;

    #[test]
    fn prompt_shape() {
        let v = prompt(7, "hi");
        assert_eq!(v["id"], 7);
        assert_eq!(v["type"], "prompt");
        assert_eq!(v["message"], "hi");
    }

    #[test]
    fn set_model_uses_split_fields() {
        let v = set_model(1, "anthropic", "claude-opus-4-8");
        assert_eq!(v["provider"], "anthropic");
        assert_eq!(v["modelId"], "claude-opus-4-8");
        assert!(from_value::<String>(v["modelId"].clone()).is_ok());
    }

    #[test]
    fn model_selector_split() {
        assert_eq!(split_model_selector("anthropic/claude-opus-4-8"), Some(("anthropic", "claude-opus-4-8")));
        assert_eq!(split_model_selector("/x"), None);
        assert_eq!(split_model_selector("x/"), None);
        assert_eq!(split_model_selector("sonnet"), None);
    }
}
