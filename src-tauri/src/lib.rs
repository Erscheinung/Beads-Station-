// Beads Station — Phase 2
// Tauri commands are registered in this file. The bd-bridge, pty-bridge,
// claude-bridge, and project-scanner agents add their own modules and
// register their commands in the .invoke_handler() block.
// Keep that block easy to merge into.

mod bd;
mod app_lifecycle;
mod agent_hooks;
mod artifacts;
mod binresolve;
mod browser;
mod claude;
mod codex;
mod conductor;
mod conductors;
mod crash_guard;
mod daily;
mod envloader;
#[cfg(target_os = "macos")]
mod finder_service;
mod fs;
mod herdr_bridge;
mod menu;
mod meter;
mod projects;
mod pty;
#[cfg(unix)]
mod pty_host;
mod sense;
mod spawngov;
mod spending;
mod telemetry;
mod transcripts;
mod update;
mod watcher;

use tauri::Manager;

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

/// `--pty-host <socket>`: run as the terminal host instead of the app.
#[cfg(unix)]
fn run_as_pty_host_if_asked() {
    let mut args = std::env::args_os().skip(1);
    if args.next().is_some_and(|flag| flag == pty_host::HOST_FLAG) {
        if let Some(socket) = args.next() {
            pty_host::run_host(std::path::Path::new(&socket));
        }
        std::process::exit(2);
    }
}
#[cfg(not(unix))]
fn run_as_pty_host_if_asked() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crash_guard::install_panic_hook();
    raise_fd_limit();
    run_as_pty_host_if_asked();

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

    let builder = tauri::Builder::default();
    // Must come first. On Windows and Linux a right-click launches the binary
    // again; this hands the folder to the running app instead.
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        let folders = app_lifecycle::folder_paths(argv.iter().skip(1).map(std::path::PathBuf::from));
        let requests = app.state::<app_lifecycle::OpenRequests>();
        app_lifecycle::queue_open_requests(app, &requests, folders);
    }));
    // Memory pressure or a WebKit bug can kill the page while Rust lives on.
    // Reload rather than leave a blank window; the panes restore themselves.
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        crash_guard::record("web content process ended; reloading the page");
        let _ = webview.reload();
    });
    let app = builder
        .manage(app_lifecycle::CloseCoordinator::default())
        .manage(app_lifecycle::OpenRequests::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_menu(menu::build(app.handle())?)?;
                finder_service::install(app.handle());
            }
            // Windows and Linux hand a folder to a first launch on the command line.
            #[cfg(not(target_os = "macos"))]
            {
                let folders = app_lifecycle::folder_paths(std::env::args_os().skip(1).map(std::path::PathBuf::from));
                let requests = app.state::<app_lifecycle::OpenRequests>();
                app_lifecycle::queue_open_requests(app.handle(), &requests, folders);
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
            menu::on_event(app, event.id().as_ref());
        })
        .on_window_event(|window, event| {
            // Only the main window owns sessions; a browser window just closes.
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<app_lifecycle::CloseCoordinator>();
                if !app_lifecycle::should_allow_close(&state) {
                    api.prevent_close();
                    app_lifecycle::request_close(window.app_handle(), &state, "window");
                }
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
            bd::bd_initialize,
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
            codex::codex_chat_start,
            codex::codex_chat_send,
            codex::codex_chat_kill,
            codex::codex_chat_get_scrollback,
            codex::codex_chat_get_session_id,
            codex::codex_chat_reconcile,
            claude::native_provider_status,
            claude::native_run_start,
            claude::native_run_cancel,
            claude::native_run_snapshot,
            claude::native_session_submit,
            conductors::codex_thread_activity,
            transcripts::transcripts_list,
            meter::meter_summary,
            transcripts::transcript_read,
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
            projects::projects_browse,
            projects::projects_cancel_discovery,
            projects::projects_discover_under_folder,
            projects::projects_open,
            projects::projects_set_roots,
            projects::projects_set_claude_session,
            pty::pty_ack,
            pty::pty_foreground,
            pty::pty_kill,
            pty::pty_persisted,
            pty::pty_release_keys,
            pty::pty_set_keep_running,
            pty::pty_resize,
            pty::pty_snapshot,
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
            app_lifecycle::app_request_close,
            app_lifecycle::app_close_scope,
            app_lifecycle::app_resolve_close,
            app_lifecycle::app_recover_stale_sessions,
            app_lifecycle::app_take_open_requests,
            browser::browser_open_window,
            browser::browser_refuses_framing,
            projects::projects_git_clone,
            crash_guard::app_last_crash,
            agent_hooks::agent_hooks_status,
            agent_hooks::agent_hooks_set_installed,
            artifacts::artifact_capture,
            artifacts::artifact_preview,
            artifacts::artifact_review,
            artifacts::artifact_verify,
            artifacts::artifact_approve,
            update::app_check_update,
            update::app_download_update,
            update::app_prepare_update,
            update::app_apply_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    crash_guard::guard_event_dispatch();

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            let state = app_handle.state::<app_lifecycle::CloseCoordinator>();
            if !app_lifecycle::should_allow_close(&state) {
                api.prevent_exit();
                app_lifecycle::request_close(app_handle, &state, "menu-quit");
            }
        }
        // Finder "Open With", a folder dropped on the Dock icon, or `open -a`.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            let folders = app_lifecycle::folder_paths(
                urls.iter().filter_map(|url| url.to_file_path().ok()),
            );
            let requests = app_handle.state::<app_lifecycle::OpenRequests>();
            app_lifecycle::queue_open_requests(app_handle, &requests, folders);
        }
        _ => {}
    });
}
