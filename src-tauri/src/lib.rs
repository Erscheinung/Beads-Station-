// Beads Station — Phase 2
// Tauri commands are registered in this file. The bd-bridge, pty-bridge,
// claude-bridge, and project-scanner agents add their own modules and
// register their commands in the .invoke_handler() block.
// Keep that block easy to merge into.

mod bd;
mod binresolve;
mod claude;
mod conductor;
mod daily;
mod envloader;
mod fs;
mod herdr_bridge;
mod projects;
mod pty;
mod sense;
mod spawngov;
mod spending;
mod telemetry;
mod watcher;

/// macOS GUI apps launched via launchd/Finder inherit the default soft
/// RLIMIT_NOFILE of 256 (a login shell gets 1048576). Against 256 the
/// startup subprocess burst (bd_counts' try_join, Board's Promise.all,
/// claude pipes, PTY, FSEvents) overflows and bd spawns start returning
/// EMFILE ("Too many open files"). Raise the soft limit toward the hard
/// limit at process start, clamped to 8192 to stay under the kernel
/// per-proc cap (kern.maxfilesperproc = 61440 on this machine). Best-effort:
/// raising the soft limit up to the hard limit needs no privilege on macOS.
#[cfg(unix)]
fn raise_fd_limit() {
    unsafe {
        let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) == 0 {
            let target = std::cmp::min(lim.rlim_max, 8192);
            if lim.rlim_cur < target {
                lim.rlim_cur = target;
                let _ = libc::setrlimit(libc::RLIMIT_NOFILE, &lim);
            }
        }
        let mut after = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        libc::getrlimit(libc::RLIMIT_NOFILE, &mut after);
        eprintln!("[fd] RLIMIT_NOFILE soft={} hard={}", after.rlim_cur, after.rlim_max);
    }
}
#[cfg(not(unix))]
fn raise_fd_limit() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    raise_fd_limit();

    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("beads_station=info")),
        )
        .try_init();

    // Phase 2.6: load .env before tauri builds so child processes spawned
    // through Command::new (claude, bd, anything in pty) inherit the
    // ANTHROPIC_* vars from std::env. install_into_process_env returns
    // only the keys (never values) so the stderr line we print here is
    // safe to read in production logs.
    envloader::prepare_auth_profile();
    let map = envloader::load_dotenv();
    let keys = envloader::install_into_process_env(&map);
    eprintln!("{}", envloader::loaded_summary(&keys));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, MenuItemKind};
                let menu = Menu::default(app.handle())?;
                if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
                    // Shortcut dispatch stays in the shared, rebindable frontend
                    // registry. A fixed native accelerator would override it.
                    app_menu.insert(&MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?, 1)?;
                }
                app.set_menu(menu)?;
            }
            telemetry::start(app.handle().clone());
            // RV3.2 debug — open the Web Inspector on launch so bd invoke
            // returns can be watched live (release WKWebview is otherwise
            // un-inspectable). Gated on the BS_DEVTOOLS env var so a normal
            // launch stays clean; set BS_DEVTOOLS=1 to pop devtools.
            if std::env::var("BS_DEVTOOLS").is_ok() {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    // Delay: open_devtools() in setup can no-op on macOS before
                    // the WKWebView is fully realized. Fire after a beat.
                    let w2 = w.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                        w2.open_devtools();
                    });
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "settings" {
                use tauri::Emitter;
                let _ = app.emit("settings:open", ());
            }
        })
        // RV2-fix (Code-51e): reap every live `claude --print` child when the
        // window closes. Without this, each visited project / spawned agent
        // pane leaked a persistent claude process for the app's lifetime —
        // the fork/subprocess-exhaustion vector behind "issues gone on project
        // switch". block_on is safe here: the close path is not latency
        // sensitive and kill_all_sessions only does a bounded drain + waits.
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let reaped = tauri::async_runtime::block_on(claude::kill_all_sessions());
                eprintln!("[claude] window close: reaped {reaped} live session(s)");
                let ptys = pty::kill_all_ptys();
                eprintln!("[pty] window close: reaped {ptys} live pty child(ren)");
            }
        })
        .invoke_handler(tauri::generate_handler![
            bd::bd_add_label,
            bd::bd_claim,
            bd::bd_close,
            bd::bd_counts,
            bd::bd_create,
            bd::bd_gate_list,
            bd::bd_gate_resolve,
            bd::bd_git_branch,
            bd::bd_list,
            bd::bd_note,
            bd::bd_prime,
            bd::bd_ready,
            bd::bd_remove_label,
            bd::bd_set_status,
            bd::bd_show,
            bd::bd_snapshot,
            claude::claude_approve,
            claude::claude_deny,
            claude::claude_get_scrollback,
            claude::claude_get_session_id,
            claude::claude_kill,
            claude::claude_kill_all,
            claude::claude_reconcile,
            claude::claude_send,
            claude::claude_set_permission_mode,
            claude::claude_start,
            claude::native_provider_status,
            claude::native_run_start,
            claude::native_run_cancel,
            conductor::conductor_start,
            conductor::conductor_stop,
            conductor::conductor_pulse_now,
            conductor::conductor_stop_agent,
            conductor::conductor_defer_bead,
            conductor::conductor_set_default_tier,
            daily::daily_append,
            fs::list_dir,
            fs::read_file,
            projects::projects_get,
            projects::projects_list,
            projects::projects_open,
            projects::projects_set_roots,
            projects::projects_set_claude_session,
            pty::pty_kill,
            pty::pty_resize,
            pty::pty_spawn,
            pty::pty_write,
            sense::sense_dismiss,
            sense::sense_list,
            sense::sense_promote,
            sense::sense_scan,
            spending::gateway_spending,
            watcher::sense_watch_start,
            watcher::sense_watch_stop,
            watcher::watcher_start,
            watcher::watcher_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
