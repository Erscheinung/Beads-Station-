// Lualine-style statusline pinned to the bottom of the app.
// Sections: mode pill | path | branch | counts | (spacer) | clock | pending dot
//
// RV3.3 — counts now come from the shared bd snapshot cache (useBdSnapshot),
// the SAME deduped fetch that feeds Board + IssueList. The statusline no longer
// spawns its own bd_counts (= bd_ready + bd_list) on a 5s poll or its own
// bd_changed listener — that independent fan-out was a big part of the 8s cold
// escalation. EXP backbone (Code-p2p): the git branch is now fetched on repo
// change ONLY, not on every bd_changed — one fewer uncached spawn per bead write.

import { useEffect, useMemo, useState } from 'react'
import { safeInvoke } from '../lib/invokeErrorBoundary'
import { abbreviatePath } from '../lib/abbreviatePath'
import { useBdSnapshot } from '../lib/bdCache'

declare global {
  interface Window {
    __bsVim?: { mode?: 'NORMAL' | 'INSERT' | 'COMMAND' }
  }
}

interface BdCounts {
  ready: number
  in_progress: number
  blocked: number
  closed: number
}

interface Props {
  repoPath: string
  projectPath: string
}

function nowHHMM(): string {
  const d = new Date()
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

export function Statusline({ repoPath, projectPath }: Props) {
  const [mode, setMode] = useState<string>(() => window.__bsVim?.mode ?? 'NORMAL')
  const [branch, setBranch] = useState<string>('…')
  const [clock, setClock] = useState<string>(nowHHMM())
  const [pending, setPending] = useState<boolean>(false)

  // RV3.3 — counts derived client-side from the shared snapshot (same match
  // arms the old bd_counts used). No independent bd subprocess.
  const snap = useBdSnapshot(repoPath)
  const counts: BdCounts = useMemo(() => {
    const c: BdCounts = { ready: snap.ready.length, in_progress: 0, blocked: 0, closed: 0 }
    for (const i of snap.all) {
      if (i.status === 'in_progress') c.in_progress++
      else if (i.status === 'blocked') c.blocked++
      else if (i.status === 'closed') c.closed++
    }
    return c
  }, [snap])

  // Mode tracking — passive read of window.__bsVim, refreshed on a tiny tick.
  useEffect(() => {
    const id = window.setInterval(() => {
      const m = window.__bsVim?.mode ?? 'NORMAL'
      setMode(prev => (prev === m ? prev : m))
    }, 250)
    return () => window.clearInterval(id)
  }, [])

  // Git branch — cheap one-shot, fetched on repo change only. It does NOT
  // refetch on bd_changed: a bead write is not a branch change, and firing an
  // unsemaphored git spawn on every bd_changed (multiplied per mounted view)
  // was part of the fan-out that fed the fork/fd storm. A genuine branch switch
  // remounts with a new repoPath, which re-runs this. (EXP backbone Code-p2p.)
  useEffect(() => {
    let cancelled = false
    safeInvoke<string>('bd_git_branch', { repoPath }, { rethrow: true })
      .then(b => { if (!cancelled) setBranch(b!) })
      .catch(() => { if (!cancelled) setBranch('(unknown)') })
    return () => { cancelled = true }
  }, [repoPath])

  // Pending-write dot — flipped by `window` events.
  useEffect(() => {
    const onPending = (e: Event) => {
      const detail = (e as CustomEvent).detail
      setPending(Boolean(detail))
    }
    window.addEventListener('bd:pending', onPending as EventListener)
    return () => window.removeEventListener('bd:pending', onPending as EventListener)
  }, [])

  // Clock — recompute every minute.
  useEffect(() => {
    const tick = () => setClock(nowHHMM())
    tick()
    const id = window.setInterval(tick, 60_000)
    return () => window.clearInterval(id)
  }, [])

  const sep = (
    <span
      style={{
        width: 1,
        alignSelf: 'stretch',
        background: 'var(--bs-border)',
        margin: '0 8px',
      }}
    />
  )

  const labelStyle: React.CSSProperties = { color: 'var(--bs-fg-muted)' }
  const valueStyle: React.CSSProperties = { color: 'var(--bs-fg)' }

  return (
    <div
      style={{
        height: 22,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        background: 'var(--bs-bg-elev)',
        borderTop: '1px solid var(--bs-border)',
        fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
        fontSize: 11,
        lineHeight: 1,
        color: 'var(--bs-fg-muted)',
        userSelect: 'none',
        gap: 0,
      }}
    >
      {/* Mode pill */}
      <span
        style={{
          height: 12,
          padding: '0 6px',
          display: 'inline-flex',
          alignItems: 'center',
          background: 'var(--bs-blue)',
          color: 'var(--bs-bg-dark)',
          fontWeight: 600,
          fontSize: 10,
          letterSpacing: '0.04em',
          borderRadius: 1,
        }}
      >
        {mode}
      </span>

      {sep}

      {/* Project path */}
      <span style={{ color: 'var(--bs-fg-muted)', fontSize: 12 }}>
        <span style={{ marginRight: 4 }}>{'›'}</span>
        {abbreviatePath(projectPath)}
      </span>

      {sep}

      {/* Branch */}
      <span style={valueStyle}>{branch}</span>

      {sep}

      {/* Counts — RV3.7 (Code-hc9): distinguish loading / error / no-db /
          real counts instead of silently rendering 0s for all four. */}
      {!snap.loaded ? (
        <span style={labelStyle}>counts …</span>
      ) : snap.error ? (
        <span style={{ ...labelStyle, color: 'var(--bs-red)' }}>bd error</span>
      ) : snap.noDb ? (
        <span style={labelStyle}>no beads db</span>
      ) : (
        <span>
          <span style={labelStyle}>ready=</span>
          <span style={valueStyle}>{counts.ready}</span>
          <span style={labelStyle}>{' blocked='}</span>
          <span style={valueStyle}>{counts.blocked}</span>
          <span style={labelStyle}>{' closed='}</span>
          <span style={valueStyle}>{counts.closed}</span>
        </span>
      )}

      {/* Spacer */}
      <span style={{ marginLeft: 'auto' }} />

      {/* Clock */}
      <span style={valueStyle}>{clock}</span>

      {pending && (
        <>
          {sep}
          <span
            aria-label="pending bd writes"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--bs-magenta)',
              display: 'inline-block',
            }}
          />
        </>
      )}
    </div>
  )
}
