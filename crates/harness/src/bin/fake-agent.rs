//! Scriptable fake agent runtime for integration tests.
//!
//! Modes:
//! - `pi`   — pi-style: no ready frame, canonical vocabulary.
//! - `omp`  — omp-style: pushes `ready`, REQUIRES negotiate before any other
//!   command (exits 3 if violated), answers get_state, streams a prompt turn.
//! - `big`  — emits a single 2 MiB line (oversized-frame test).
//! - `chunked` — omp-style ready + one large event split into 3 rpc_chunks.
//!
//! Exit code 0 = protocol contract held.

use std::io::{BufRead, Write};

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();

    let mut negotiated = false;

    if mode == "omp" || mode == "chunked" {
        emit(
            &mut out,
            r#"{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}"#,
        );
    }

    if mode == "big" {
        let line = format!("\"{}\"", "x".repeat(2 * 1024 * 1024));
        let _ = writeln!(out, "{{\"type\":\"notice\",\"text\":{line}}}").and_then(|_| out.flush());
        std::thread::sleep(std::time::Duration::from_millis(3000));
        return;
    }

    if mode == "chunked" {
        // One big event, split into three base64 rpc_chunks (omp protocol v2).
        let frame = format!("{{\"type\":\"agent_start\",\"note\":\"{}\"}}", "y".repeat(1_500_000));
        let chunks: Vec<&[u8]> = frame.as_bytes().chunks(700_000).collect();
        use base64::Engine as _;
        for (i, part) in chunks.iter().enumerate() {
            let data = base64::engine::general_purpose::STANDARD.encode(part);
            let _ = writeln!(
                out,
                "{{\"type\":\"rpc_chunk\",\"chunkId\":9,\"index\":{i},\"count\":{},\"data\":\"{data}\"}}",
                chunks.len()
            )
            .and_then(|_| out.flush());
        }
        // Stay alive long enough for the test to read.
        std::thread::sleep(std::time::Duration::from_millis(3000));
        return;
    }

    while let Some(Ok(line)) = lines.next() {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
        // Correlation is opt-in: "the corresponding response will include the
        // same id" only when the command carried one. Fabricating an id here
        // would let an uncorrelated response resolve somebody else's request.
        let id_field = match v.get("id").and_then(|t| t.as_u64()) {
            Some(id) => format!(r#""id":{id},"#),
            None => String::new(),
        };

        match kind.as_str() {
            "negotiate_protocol" => {
                negotiated = true;
                emit(
                    &mut out,
                    &format!(
                        r#"{{{id_field}"type":"response","command":"negotiate_protocol","success":true,"data":{{"protocolVersion":2}}}}"#
                    ),
                );
                emit(&mut out, r#"{"type":"notice","text":"negotiated:v2"}"#);
            }
            "get_state" => {
                emit(
                    &mut out,
                    &format!(
                        r#"{{{id_field}"type":"response","command":"get_state","success":true,"data":{{"isStreaming":false,"sessionId":"fake","messageCount":0}}}}"#
                    ),
                );
            }
            "prompt" => {
                if mode == "omp" && !negotiated {
                    std::process::exit(3); // contract violation: prompt before negotiate
                }
                emit(&mut out, &format!(r#"{{{id_field}"type":"response","command":"prompt","success":true}}"#));
                emit(&mut out, r#"{"type":"agent_start"}"#);
                emit(&mut out, r#"{"type":"turn_start"}"#);
                emit(&mut out, r#"{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#);
                emit(&mut out, r#"{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#);
                emit(&mut out, r#"{"type":"message_start","message":{"role":"assistant","content":[]}}"#);
                emit(
                    &mut out,
                    r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"o"}}"#,
                );
                emit(
                    &mut out,
                    r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"k"}}"#,
                );
                emit(
                    &mut out,
                    r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"ok"}}"#,
                );
                emit(&mut out, r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop","usage":{"totalTokens":3}}}"#);
                emit(&mut out, r#"{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}"#);
                if mode == "omp" {
                    // Non-terminal agent_end must be swallowed by the adapter.
                    emit(&mut out, r#"{"type":"agent_end","isTerminal":false}"#);
                }
                emit(&mut out, r#"{"type":"agent_end"}"#);
                if mode == "pi" {
                    emit(&mut out, r#"{"type":"agent_settled"}"#);
                }
            }
            _ => {
                emit(
                    &mut out,
                    &format!(r#"{{{id_field}"type":"response","command":"{kind}","success":false,"error":{{"name":"Error","message":"unknown command"}}}}"#),
                );
            }
        }
    }
}

fn emit(out: &mut impl Write, line: &str) {
    let _ = writeln!(out, "{line}").and_then(|_| out.flush());
}
