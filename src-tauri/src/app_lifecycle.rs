use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct CloseCoordinator {
    pending: AtomicBool,
    allow_exit: AtomicBool,
}

impl CloseCoordinator {
    fn begin(&self) -> bool {
        !self.pending.swap(true, Ordering::SeqCst)
    }

    fn cancel(&self) {
        self.pending.store(false, Ordering::SeqCst);
    }

    fn allow(&self) -> bool {
        self.allow_exit.load(Ordering::SeqCst)
    }

    fn has_pending(&self) -> bool {
        self.pending.load(Ordering::SeqCst)
    }

    fn complete_stop(&self) {
        self.pending.store(false, Ordering::SeqCst);
        self.allow_exit.store(true, Ordering::SeqCst);
    }
}

#[derive(Clone, Serialize)]
pub struct CloseRequest<'a> {
    source: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseScope {
    pty_count: usize,
    provider_count: usize,
    run_count: usize,
}

pub fn request_close(app: &AppHandle, coordinator: &CloseCoordinator, source: &str) {
    if coordinator.begin() {
        let _ = app.emit("app:close-requested", CloseRequest { source });
    }
}

pub fn should_allow_close(coordinator: &CloseCoordinator) -> bool {
    coordinator.allow()
}

#[tauri::command]
pub fn app_request_close(app: AppHandle, state: tauri::State<'_, CloseCoordinator>, source: String) {
    request_close(&app, &state, &source);
}

#[tauri::command]
pub async fn app_close_scope() -> Result<CloseScope, String> {
    let (claude_count, native_run_count) = crate::claude::active_close_scope().await;
    Ok(CloseScope {
        pty_count: crate::pty::active_pty_count(),
        provider_count: claude_count + crate::codex::active_codex_session_count().await,
        run_count: native_run_count + crate::conductor::active_owned_run_count(),
    })
}

#[tauri::command]
pub async fn app_resolve_close(
    app: AppHandle,
    state: tauri::State<'_, CloseCoordinator>,
    stop_sessions: bool,
) -> Result<(), String> {
    if !stop_sessions {
        state.cancel();
        return Ok(());
    }
    if !state.has_pending() {
        return Ok(());
    }

    // These registries are the app's ownership boundary. Do not inspect or
    // terminate unrelated provider/terminal processes on the machine.
    let conductor_runs = crate::conductor::stop_owned_work_for_close(&app).await?;
    let providers_and_runs = crate::claude::kill_all_sessions().await;
    let ptys = crate::pty::kill_all_ptys();
    eprintln!("[lifecycle] close: stopped {conductor_runs} conductor run(s), reaped {providers_and_runs} provider/run child(ren), {ptys} pty child(ren)");
    state.complete_stop();
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn app_recover_stale_sessions(app: AppHandle) -> Result<CloseScope, String> {
    let (claude_count, native_run_count) = crate::claude::active_close_scope().await;
    let conductor_run_count = crate::conductor::active_owned_run_count();
    let provider_count = claude_count + crate::codex::active_codex_session_count().await;
    let pty_count = crate::pty::active_pty_count();
    crate::conductor::stop_owned_work_for_close(&app).await?;
    crate::claude::kill_all_sessions().await;
    crate::pty::kill_all_ptys();
    Ok(CloseScope {
        pty_count,
        provider_count,
        run_count: native_run_count + conductor_run_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_requests_collapse_until_cancel() {
        let state = CloseCoordinator::default();
        assert!(state.begin());
        assert!(!state.begin());
        state.cancel();
        assert!(state.begin());
    }

    #[test]
    fn stop_resolution_allows_exactly_one_exit() {
        let state = CloseCoordinator::default();
        assert!(!state.has_pending());
        assert!(state.begin());
        assert!(state.has_pending());
        state.complete_stop();
        assert!(state.allow());
        assert!(!state.has_pending());
    }
}
