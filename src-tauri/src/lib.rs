//! Pi Desktop — a minimal, SSH-first desktop cockpit for the pi and omp
//! coding agents.

mod runtime;

use harness::harness::HarnessId;
use runtime::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            runtime::runtime_start,
            runtime::runtime_request,
            runtime::runtime_send,
            runtime::runtime_kill,
            runtime::runtimes_list,
            runtime::sessions_list,
            runtime::session_tree,
            runtime::session_delete,
            runtime::usage_report,
            runtime::session_tree_remote,
            runtime::models_list,
            runtime::providers_list,
            runtime::provider_upsert,
            runtime::provider_remove,
            runtime::provider_test,
            runtime::ssh_hosts_list,
            runtime::ssh_host_add,
            runtime::ssh_host_remove,
            runtime::ssh_host_test,
            runtime::auth_print_key,
            runtime::ssh_bootstrap,
            runtime::fs_list,
            runtime::git_status,
            runtime::ssh_fs_list,
            runtime::ssh_fs_read,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Re-export for the UI-side harness id literals.
pub const HARNESS_IDS: [HarnessId; 2] = [HarnessId::Pi, HarnessId::Omp];
