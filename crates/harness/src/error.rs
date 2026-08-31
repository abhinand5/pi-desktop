//! Error types for the harness protocol core.

use thiserror::Error;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml_ng::Error),

    #[error("frame exceeds {limit} bytes")]
    OversizedFrame { limit: u64 },

    #[error("child process exited: {status}")]
    ProcessExited { status: String },

    #[error("process failed to start: {0}")]
    Spawn(String),

    #[error("handshake failed: {0}")]
    Handshake(String),

    #[error("unexpected response shape: {0}")]
    UnexpectedResponse(String),

    #[error("command rejected: {0}")]
    CommandRejected(String),

    #[error("harness binary not found: {0}")]
    BinaryNotFound(String),

    #[error("unsupported for this harness: {0}")]
    Unsupported(String),

    #[error("{0}")]
    Other(String),
}
