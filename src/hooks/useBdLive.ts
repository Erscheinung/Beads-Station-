// DEPRECATED (R1): superseded by src/lib/BdLiveProvider.tsx (useBdLiveContext). Kept for reference; no live callers.
// Phase 3 — file-watch bridge.
//
// Wires a Tauri-side notify::RecommendedWatcher (FSEvents on macOS) to
// a React `onBump` callback. Whenever bd writes interactions.jsonl,
// export-state.json, or anything else under the project's `.beads/`
// dir — from the app, from another terminal, or from a hook — the
// backend coalesces a 250ms burst and emits `bd_changed:{repoPath}`.
// We debounce a second time at 100ms here in case multiple sources
// race close together.

import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

const REACT_DEBOUNCE_MS = 100

/**
 * Subscribes to backend file-watch events for `repoPath/.beads/` and
 * calls `onBump` on each (debounced) change. Idempotent — re-mounting
 * with the same repoPath is safe; the backend treats a duplicate
 * watcher_start as a no-op.
 */
export function useBdLive(repoPath: string, onBump: () => void): void {
  // onBump is held in a ref so the listener doesn't tear down + re-arm
  // every time the parent re-renders with a new closure identity.
  const onBumpRef = useRef(onBump)
  useEffect(() => {
    onBumpRef.current = onBump
  }, [onBump])

  useEffect(() => {
    if (!repoPath) return

    let unlisten: UnlistenFn | null = null
    let cancelled = false
    let pending: ReturnType<typeof setTimeout> | null = null

    const trigger = () => {
      if (pending !== null) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        onBumpRef.current()
      }, REACT_DEBOUNCE_MS)
    }

    ;(async () => {
      try {
        await invoke('watcher_start', { repoPath })
      } catch (err) {
        // Surface to console but don't crash the UI — the worst case is
        // staleness until the user manually refetches.
        console.warn('[useBdLive] watcher_start failed:', err)
        return
      }
      if (cancelled) return

      try {
        unlisten = await listen(`bd_changed:${repoPath}`, () => {
          trigger()
        })
      } catch (err) {
        console.warn('[useBdLive] listen failed:', err)
      }
    })()

    return () => {
      cancelled = true
      if (pending !== null) {
        clearTimeout(pending)
        pending = null
      }
      if (unlisten) {
        unlisten()
        unlisten = null
      }
      // Note: we don't call watcher_stop on unmount. Phase 3 has a
      // single global watcher; it'll be replaced if a different repo
      // mounts, and dropped on app exit. Stopping here would race a
      // remount with the same repoPath.
    }
  }, [repoPath])
}
