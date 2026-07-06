// Beads Station — R0
// Fixed-position debug panel. F12 toggles. Renders live process RSS +
// tokio task count from the Rust `debug_stats` event and the JS-side
// listener-registry counts. Mounted from App.tsx guarded by
// import.meta.env.DEV; Rust side additionally cfg(debug_assertions).
//
// Uses raw listen() (not safeListen) intentionally — subscribing the
// overlay to the registry via itself would double-count on every mount.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getListenerCounts, subscribeListenerCounts } from '../lib/listenerRegistry'

type DebugStats = {
  rss_mb: number
  tokio_tasks: number
  sampled_at_ms: number
}

const initialCounts: Record<string, number> = Object.create(null)

export function DebugOverlay() {
  const [visible, setVisible] = useState(false)
  const [stats, setStats] = useState<DebugStats | null>(null)
  const listenerCounts = useSyncExternalStore(
    subscribeListenerCounts,
    getListenerCounts,
    () => initialCounts,
  )

  // F12 toggle. Bypass when a text input is focused so devtools shortcut
  // hierarchy still makes sense (F12 also opens native devtools in some
  // wrappers — that's fine, both can fire).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F12') return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return
      e.preventDefault()
      setVisible(v => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Subscribe to Rust sampler stream while visible. Unsubscribe on hide
  // so an unopened overlay costs zero listeners.
  useEffect(() => {
    if (!visible) return
    let unlisten: (() => void) | null = null
    let cancelled = false
    ;(async () => {
      const un = await listen<DebugStats>('debug_stats', (evt) => {
        if (cancelled) return
        setStats(evt.payload)
      })
      if (cancelled) {
        un()
        return
      }
      unlisten = un
    })()
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [visible])

  if (!visible) return null

  const rss = stats?.rss_mb ?? 0
  const tasks = stats?.tokio_tasks ?? 0
  const bucketRows = Object.entries(listenerCounts)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="bs-debug-overlay">
      <div className="bs-debug-header">
        <span>debug · dev only</span>
        <span className="bs-debug-hint">F12 to hide</span>
      </div>
      <div className="bs-debug-body">
        <div className="bs-debug-row">
          <span className="bs-debug-key">rss</span>
          <strong>{rss}</strong>
          <span className="bs-debug-unit">MB</span>
        </div>
        <div className="bs-debug-row">
          <span className="bs-debug-key">tokio tasks</span>
          <strong>{tasks}</strong>
        </div>
        <div className="bs-debug-row">
          <span className="bs-debug-key">listeners</span>
          <strong>{bucketRows.reduce((a, [, n]) => a + n, 0)}</strong>
        </div>
        {bucketRows.length === 0 ? (
          <div className="bs-debug-empty">no tracked channels — call sites still on raw listen()</div>
        ) : (
          bucketRows.map(([bucket, n]) => (
            <div key={bucket} className="bs-debug-row bs-debug-row--sub">
              <span className="bs-debug-key">· {bucket}</span>
              <strong>{n}</strong>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
