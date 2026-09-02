//! pi-desktop harness core: drives pi and omp coding agents over their native
//! stdio JSONL RPC protocols. Transport-agnostic (local child process today,
//! SSH exec channel later), harness-adapter-isolated, golden-file tested.

pub mod client;
pub mod commands;
pub mod config;
pub mod error;
pub mod events;
pub mod framing;
pub mod harness;
pub mod models;
pub mod proxy;
pub mod sessions;
pub mod spec;
pub mod ssh;
pub mod tree;
pub mod usage;

pub use proxy::EgressProxy;

pub use client::{ClientOptions, ExitInfo, RpcClient};
pub use commands as cmd;
pub use error::{Error, Result};
pub use events::Event;
pub use harness::{by_id, Harness, HarnessId};
pub use models::ModelInfo;
pub use sessions::SessionSummary;
pub use tree::{read_tree, SessionTree, TreeNode};
pub use config::DefaultModel;
pub use usage::UsageReport;
pub use spec::{CommandSpec, LocalSpawner, SpawnOptions, Spawner};
