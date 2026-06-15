// Beads Station — Phase 3 file watcher.
//
// Watches `<repo_path>/.beads/` recursively via notify (FSEvents on
// macOS) so that when bd writes interactions.jsonl, export-state.json,
// or anything under embeddeddolt/, the frontend can re-fetch.
//
// Single-watcher design: bd has exactly one canonical DB per project,
// and Phase 3 has exactly one project root active at a time. We hold a
// global `Lazy<Mutex<Option<RecommendedWatcher>>>` so the watcher
// outlives this function call (dropping it stops the watch).
//
// Debouncing: macOS FSEvents already coalesces, but Dolt + bd hooks
// produce event bursts (e.g. write the jsonl, then update
// export-state.json a few ms later). We coalesce events within 250ms
// in a background tokio task before emitting the Tauri event. The
// frontend hook (useBdLive) debounces a second time at 100ms in case
// multiple sources fire close together.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{Emitter, Window};
use tokio::sync::mpsc;

const DEBOUNCE_MS: u64 = 250;

/// Holds the active watcher for the lifetime of the app. Dropping the
/// `RecommendedWatcher` stops FSEvents delivery, so we keep it parked
/// in a `Lazy<Mutex<Option<_>>>`. The current repo path is tracked
/// alongside so a second watcher_start for the same path is a no-op.
struct WatcherState {
    // Held only to keep the watcher alive — dropping it stops FSEvents.
    #[allow(dead_code)]
    watcher: RecommendedWatcher,
    repo_path: String,
}

static WATCHER: Lazy<Mutex<Option<WatcherState>>> = Lazy::new(|| Mutex::new(None));

#[derive(Serialize, Clone)]
struct BdChangedPayload {
    path: String,
    kind: &'static str,
}

/// Start watching `<repo_path>/.beads/` and emit
/// `bd_changed:{repo_path}` whenever a debounced event fires.
///
/// Idempotent: calling twice with the same `repo_path` is a no-op.
/// Calling with a different `repo_path` replaces the previous watcher.
#[tauri::command]
pub async fn watcher_start(window: Window, repo_path: String) -> Result<(), String> {
    let beads_dir: PathBuf = Path::new(&repo_path).join(".beads");
    if !beads_dir.exists() {
        return Err(format!(
            ".beads directory not found at {} — is this a bd-tracked repo?",
            beads_dir.display()
        ));
    }

    // Fast path: already watching this exact repo.
    {
        let guard = WATCHER.lock().map_err(|e| format!("watcher lock: {e}"))?;
        if let Some(state) = guard.as_ref() {
            if state.repo_path == repo_path {
                return Ok(());
            }
        }
    }

    // mpsc channel: notify's callback runs on a background thread and
    // shoves raw events into `tx`; the debouncer task reads from `rx`,
    // coalesces 250ms windows, and emits to the frontend.
    let (tx, mut rx) = mpsc::unbounded_channel::<PathBuf>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            // First path is enough for the debouncer — we just need to
            // know *something* changed. The exact file isn't load-bearing.
            if let Some(p) = event.paths.into_iter().next() {
                let _ = tx.send(p);
            }
        }
    })
    .map_err(|e| format!("create watcher: {e}"))?;

    watcher
        .watch(&beads_dir, RecursiveMode::Recursive)
        .map_err(|e| format!("watch {}: {e}", beads_dir.display()))?;

    // Park the watcher so it isn't dropped at end-of-scope.
    {
        let mut guard = WATCHER.lock().map_err(|e| format!("watcher lock: {e}"))?;
        *guard = Some(WatcherState {
            watcher,
            repo_path: repo_path.clone(),
        });
    }

    // Debouncer + emitter task. Pulls events as they arrive, coalesces
    // anything that lands inside a 250ms window after the *first* event
    // of a burst, then emits a single `bd_changed:{repo_path}` payload.
    let event_name = format!("bd_changed:{repo_path}");
    tokio::spawn(async move {
        loop {
            // Block until the next event (or channel close).
            let first = match rx.recv().await {
                Some(p) => p,
                None => break,
            };
            let burst_started = Instant::now();
            let mut last_path = first;

            // Drain anything else that arrives within the debounce window.
            loop {
                let elapsed = burst_started.elapsed();
                if elapsed >= Duration::from_millis(DEBOUNCE_MS) {
                    break;
                }
                let remaining = Duration::from_millis(DEBOUNCE_MS) - elapsed;
                match tokio::time::timeout(remaining, rx.recv()).await {
                    Ok(Some(p)) => {
                        last_path = p;
                    }
                    Ok(None) => return, // channel closed, watcher dropped
                    Err(_) => break,    // timeout — burst is over
                }
            }

            let payload = BdChangedPayload {
                path: last_path.to_string_lossy().into_owned(),
                kind: "modify",
            };
            let _ = window.emit(&event_name, payload);
        }
    });

    Ok(())
}

/// Drop the active watcher. Idempotent — succeeds even when no watcher
/// is currently running.
#[tauri::command]
pub async fn watcher_stop() -> Result<(), String> {
    let mut guard = WATCHER.lock().map_err(|e| format!("watcher lock: {e}"))?;
    *guard = None; // Drop stops FSEvents.
    Ok(())
}
