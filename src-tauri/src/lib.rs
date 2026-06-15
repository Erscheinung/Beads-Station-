// Beads Station — Phase 2
// Tauri commands are registered in this file. The bd-bridge, pty-bridge,
// claude-bridge, and project-scanner agents add their own modules and
// register their commands in the .invoke_handler() block.
// Keep that block easy to merge into.

mod bd;
mod binresolve;
mod claude;
mod envloader;
mod projects;
mod pty;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Phase 2.6: load .env before tauri builds so child processes spawned
    // through Command::new (claude, bd, anything in pty) inherit the
    // ANTHROPIC_* vars from std::env. install_into_process_env returns
    // only the keys (never values) so the stderr line we print here is
    // safe to read in production logs.
    let map = envloader::load_dotenv();
    let keys = envloader::install_into_process_env(&map);
    eprintln!("{}", envloader::loaded_summary(&keys));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            bd::bd_add_label,
            bd::bd_claim,
            bd::bd_close,
            bd::bd_counts,
            bd::bd_git_branch,
            bd::bd_list,
            bd::bd_note,
            bd::bd_ready,
            bd::bd_remove_label,
            bd::bd_set_status,
            bd::bd_show,
            claude::claude_kill,
            claude::claude_send,
            claude::claude_start,
            projects::projects_get,
            projects::projects_list,
            projects::projects_set_claude_session,
            pty::pty_kill,
            pty::pty_resize,
            pty::pty_spawn,
            pty::pty_write,
            watcher::watcher_start,
            watcher::watcher_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
