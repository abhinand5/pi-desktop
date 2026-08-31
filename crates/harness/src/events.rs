//! Canonical event view over raw harness JSONL events.
//!
//! The client broadcasts harness events after per-harness normalization
//! (renames, turn-boundary swallowing). This wrapper extracts the fields the
//! UI needs without forcing a closed enum over a wide, evolving surface.

use std::sync::Arc;

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Event(pub Arc<Value>);

impl Event {
    pub fn from_value(v: Value) -> Self {
        Self(Arc::new(v))
    }

    pub fn value(&self) -> &Value {
        &self.0
    }

    pub fn kind(&self) -> &str {
        self.0.get("type").and_then(Value::as_str).unwrap_or("")
    }

    pub fn is_agent_start(&self) -> bool {
        self.kind() == "agent_start"
    }

    pub fn is_agent_end(&self) -> bool {
        self.kind() == "agent_end"
    }

    pub fn is_agent_settled(&self) -> bool {
        self.kind() == "agent_settled"
    }

    /// Streaming assistant text delta, if this is one.
    pub fn assistant_text_delta(&self) -> Option<&str> {
        if self.kind() != "message_update" {
            return None;
        }
        let ev = self.0.get("assistantMessageEvent")?;
        if ev.get("type")?.as_str()? != "text_delta" {
            return None;
        }
        ev.get("delta").and_then(Value::as_str)
    }

    /// A completed assistant message, if this event carries one.
    pub fn assistant_message_end(&self) -> Option<&Value> {
        if self.kind() != "message_end" {
            return None;
        }
        let m = self.0.get("message")?;
        if m.get("role")?.as_str()? == "assistant" {
            Some(m)
        } else {
            None
        }
    }

    /// Last model's provider ("anthropic") from any message-carrying event.
    pub fn message_provider(&self) -> Option<&str> {
        self.0
            .get("message")
            .and_then(|m| m.get("provider"))
            .and_then(Value::as_str)
    }

    pub fn message_model(&self) -> Option<&str> {
        self.0.get("message").and_then(|m| m.get("model")).and_then(Value::as_str)
    }

    /// Turn-level error text (auth failures, provider errors) if present.
    pub fn error_message(&self) -> Option<&str> {
        self.0
            .get("message")
            .and_then(|m| m.get("errorMessage"))
            .and_then(Value::as_str)
            .or_else(|| self.0.get("errorMessage").and_then(Value::as_str))
    }

    pub fn stop_reason(&self) -> Option<&str> {
        self.0.get("message").and_then(|m| m.get("stopReason")).and_then(Value::as_str)
    }

    /// Token usage object from a message event, if present.
    pub fn usage(&self) -> Option<&Value> {
        self.0.get("message").and_then(|m| m.get("usage"))
    }

    /// Tool execution start/progress/end events (kind, tool name).
    pub fn tool_execution(&self) -> Option<(&str, &str)> {
        let k = self.kind();
        if !k.starts_with("tool_execution") {
            return None;
        }
        let name = self.0.pointer("/toolCall/name").and_then(Value::as_str)?;
        Some((k, name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(v: Value) -> Event {
        Event::from_value(v)
    }

    #[test]
    fn extracts_text_delta() {
        let e = ev(json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": "ok" }
        }));
        assert_eq!(e.assistant_text_delta(), Some("ok"));
    }

    #[test]
    fn text_delta_requires_matching_event_type() {
        let e = ev(json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "text_start", "delta": "nope" }
        }));
        assert_eq!(e.assistant_text_delta(), None);
        let e = ev(json!({ "type": "agent_start" }));
        assert_eq!(e.assistant_text_delta(), None);
    }

    #[test]
    fn surfaces_auth_error_shape() {
        // Live-captured failure shape: message_end with stopReason "error".
        let e = ev(json!({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [],
                "provider": "anthropic",
                "model": "claude-opus-4-8",
                "stopReason": "error",
                "errorMessage": "OAuth refresh failed for anthropic: Refresh token expired"
            }
        }));
        assert_eq!(e.stop_reason(), Some("error"));
        assert!(e.error_message().unwrap().contains("OAuth refresh"));
        assert_eq!(e.message_provider(), Some("anthropic"));
        assert!(e.assistant_message_end().is_some());
    }

    #[test]
    fn assistant_end_requires_assistant_role() {
        let e = ev(json!({ "type": "message_end", "message": { "role": "user", "content": [] } }));
        assert!(e.assistant_message_end().is_none());
    }

    #[test]
    fn tool_execution_name() {
        let e = ev(json!({
            "type": "tool_execution_start",
            "toolCall": { "name": "bash", "arguments": { "command": "ls" } }
        }));
        assert_eq!(e.tool_execution(), Some(("tool_execution_start", "bash")));
    }
}
