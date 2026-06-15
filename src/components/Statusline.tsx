// Lualine-style statusline pinned to the bottom of the app.
// Sections: mode pill | path | branch | counts | (spacer) | clock | pending dot
//
// Polls bd_git_branch + bd_counts every 5s and on window focus, and also
// listens to the same `bd_changed:{repoPath}` event the board uses for
// reactive count updates.

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

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

function abbreviatePath(p: string): string {
  // Collapse $HOME → ~. We can't read process.env at runtime in renderer,
  // but the convention on macOS is /Users/<name>/... — match the leading
  // /Users/<segment>/ and replace with ~/.
  const m = p.match(/^\/Users\/[^/]+(\/.*)?$/)
  if (m) return '~' + (m[1] ?? '')
  return p
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
  const [counts, setCounts] = useState<BdCounts>({ ready: 0, in_progress: 0, blocked: 0, closed: 0 })
  const [clock, setClock] = useState<string>(nowHHMM())
  const [pending, setPending] = useState<boolean>(false)

  // Mode tracking — passive read of window.__bsVim, refreshed on a tiny tick.
  useEffect(() => {
    const id = window.setInterval(() => {
      const m = window.__bsVim?.mode ?? 'NORMAL'
      setMode(prev => (prev === m ? prev : m))
    }, 250)
    return () => window.clearInterval(id)
  }, [])

  // Branch + counts fetch loop.
  useEffect(() => {
    let cancelled = false
    async function refresh() {
      try {
        const [b, c] = await Promise.all([
          invoke<string>('bd_git_branch', { repoPath }),
          invoke<BdCounts>('bd_counts', { repoPath }),
        ])
        if (cancelled) return
        setBranch(b)
        setCounts(c)
      } catch {
        if (cancelled) return
        setBranch('(unknown)')
      }
    }
    refresh()
    const id = window.setInterval(refresh, 5000)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [repoPath])

  // Reactive bd_changed listener — same channel the board uses.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    listen(`bd_changed:${repoPath}`, async () => {
      try {
        const c = await invoke<BdCounts>('bd_counts', { repoPath })
        if (!cancelled) setCounts(c)
      } catch {
        /* swallow */
      }
    }).then(fn => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
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

      {/* Counts */}
      <span>
        <span style={labelStyle}>ready=</span>
        <span style={valueStyle}>{counts.ready}</span>
        <span style={labelStyle}>{' blocked='}</span>
        <span style={valueStyle}>{counts.blocked}</span>
        <span style={labelStyle}>{' closed='}</span>
        <span style={valueStyle}>{counts.closed}</span>
      </span>

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
