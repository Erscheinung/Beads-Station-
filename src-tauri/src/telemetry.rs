// Beads Station — R0
// Telemetry sampler. Emits a `debug_stats` event with process RSS and
// tokio alive-task count on a 1s cadence in debug builds only. Production
// builds skip the spawn call in lib.rs::setup — see cfg(debug_assertions).
//
// The JS side pairs this with its own listener-registry count in
// DebugOverlay; we don't cross the boundary for that number.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct DebugStats {
    pub rss_mb: u64,
    pub tokio_tasks: usize,
    pub sampled_at_ms: u128,
}

#[cfg(debug_assertions)]
pub fn start(handle: AppHandle) {
    // Own System across ticks — refresh_process is cheaper than a fresh
    // System per second. Mutex is a rt-safe wrapper over the tokio task's
    // captured mut borrow; the task is the only writer.
    let sys = Mutex::new(System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing().with_memory()),
    ));
    let pid = Pid::from_u32(std::process::id());

    // NOTE: use tauri::async_runtime::spawn — .setup() runs outside a live
    // tokio runtime context, so bare tokio::spawn panics with "no reactor
    // running". Tauri's wrapper routes onto the same runtime it manages;
    // Handle::current().metrics() inside the task still works because by the
    // time the async body runs we're on the tokio runtime tauri owns.
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let rss_mb = {
                let mut s = sys.lock().unwrap();
                s.refresh_processes_specifics(
                    sysinfo::ProcessesToUpdate::Some(&[pid]),
                    true,
                    ProcessRefreshKind::nothing().with_memory(),
                );
                s.process(pid).map(|p| p.memory() / (1024 * 1024)).unwrap_or(0)
            };
            let tokio_tasks =
                tokio::runtime::Handle::current().metrics().num_alive_tasks();
            let sampled_at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let payload = DebugStats { rss_mb, tokio_tasks, sampled_at_ms };
            let _ = handle.emit("debug_stats", payload);
        }
    });
}

#[cfg(not(debug_assertions))]
pub fn start(_handle: AppHandle) {
    // no-op in release builds
}
