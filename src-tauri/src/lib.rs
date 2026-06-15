// Beads Station — Phase 2
// Tauri commands are registered in this file. The bd-bridge, pty-bridge,
// claude-bridge, and project-scanner agents add their own modules and
// register their commands in the .invoke_handler() block.
// Keep that block easy to merge into.

mod bd;
mod binresolve;
mod claude;
mod projects;
mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            bd::bd_list,
            bd::bd_ready,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
