// Beads Station — Phase 1
// Tauri commands are registered in this file. The bd-bridge, pty-bridge,
// and claude-bridge agents will add their own modules (bd.rs, pty.rs,
// claude.rs) and register their commands in the .invoke_handler() block.
// Keep that block easy to merge into.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![/* INVOKE_HANDLERS */])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
