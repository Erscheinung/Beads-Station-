import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { abbreviatePath } from '../lib/abbreviatePath'
import type { Project } from '../state/projects'
import { useClaudeStatus, type ClaudeStatus } from '../state/claudeStatus'
import { notifiedWorkspaceIds, usePaneNotifications } from '../state/paneNotifications'
import { startPointerReorder } from '../lib/pointerDrag'

interface TabBarProps {
  projects: Project[]
  activeId: string | null
  onSelect: (id: string) => void
  onReorder?: (fromId: string, toId: string) => void
  onOpen?: () => void
  onClose?: (id: string) => void
}

// Phase 6 — per-tab Claude status dot. Mounted as a child component so each
// tab subscribes to claudeStatus independently (one useSyncExternalStore per
// projectId; no top-level subscribe storm). Idle uses visibility:hidden so
// the slot keeps its width and the existing hasBeads dot doesn't shift when
// a session starts.
function statusColor(s: ClaudeStatus): string {
  switch (s) {
    case 'running':        return 'var(--bs-green)'
    case 'awaiting-input': return 'var(--bs-yellow)'
    case 'error':          return 'var(--bs-red)'
    default:               return 'transparent'
  }
}

function TabStatusDot({ projectId }: { projectId: string }) {
  const status = useClaudeStatus(projectId)
  const className = status === 'idle' ? 'bs-tab-status bs-tab-status--idle' : 'bs-tab-status'
  return (
    <span
      aria-label={`claude status: ${status}`}
      className={className}
      style={{ background: statusColor(status) }}
    />
  )
}

/**
 * Bufferline-style horizontal tab strip. Tokyonight palette only — no new
 * colors. Each tab is capped at 240px and truncates with an ellipsis. Active
 * tab gets a solid bottom-border in --bs-blue, raised --bs-bg-elev background
 * and brightened foreground; inactive tabs sit muted with a transparent
 * bottom border so the active swap doesn't shift layout. Overflow scrolls
 * horizontally with a thin custom scrollbar, and the active tab is scrolled
 * into view on selection change.
 */
export function TabBar({ projects, activeId, onSelect, onReorder, onOpen, onClose }: TabBarProps) {
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const [announcement, setAnnouncement] = useState('')
  // A workspace is marked while one of its panes is waiting. The visible
  // workspace shows the pane's own ring instead.
  const waitingWorkspaces = notifiedWorkspaceIds(usePaneNotifications())
  const strip = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // The chevron exists only while the strip really scrolls. One observer on the
  // strip itself; tab additions change scrollWidth without resizing it, hence
  // the re-check when the list changes.
  const measure = () => {
    const el = strip.current
    if (el) setOverflowing(el.scrollWidth > el.clientWidth + 1)
  }
  useLayoutEffect(measure, [projects, onClose, onOpen])
  useEffect(() => {
    const el = strip.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { if (!overflowing) setMenuOpen(false) }, [overflowing])
  useEffect(() => {
    if (!menuOpen) return
    const close = (event: Event) => { if (!(event.target as Element | null)?.closest?.('[data-tab-overflow]')) setMenuOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  useEffect(() => {
    if (!activeId) return
    const el = tabRefs.current.get(activeId)
    if (el) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }
  }, [activeId])

  const moveWithKeyboard = (id: string, delta: -1 | 1) => {
    const index = projects.findIndex(project => project.id === id)
    const target = projects[index + delta]
    if (!target || !onReorder) return
    onReorder(id, target.id)
    setAnnouncement(`${projects[index].name} moved ${delta < 0 ? 'before' : 'after'} ${target.name}`)
  }

  return (
    <div className="bs-tabbar" style={{ display: 'flex', flexShrink: 0, position: 'relative', minWidth: 0, background: 'var(--bs-bg)', borderBottom: '1px solid var(--bs-border)' }}>
    <div
      ref={strip}
      className="bs-tabstrip"
      role="tablist"
      aria-label="Workspaces"
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'stretch',
        height: 32,
        flex: '1 1 auto',
        minWidth: 0,
        overflowX: 'auto',
        overflowY: 'hidden',
      }}
    >
      <span role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{announcement}</span>
      {projects.map(p => {
        const active = p.id === activeId
        return (
          <div key={p.id} style={{ display: 'flex', flexShrink: 0, background: active ? 'var(--bs-bg-elev)' : 'transparent' }}>
          <button
            data-workspace-tab={p.id}
            onPointerDown={onReorder ? event => startPointerReorder(event, p.id, 'data-workspace-tab', (from, to) => {
              const fromProject = projects.find(project => project.id === from)
              const toProject = projects.find(project => project.id === to)
              if (!fromProject || !toProject) return
              const relation = projects.indexOf(fromProject) < projects.indexOf(toProject) ? 'after' : 'before'
              onReorder(from, to)
              setAnnouncement(`${fromProject.name} moved ${relation} ${toProject.name}`)
            }) : undefined}
            ref={el => {
              if (el) tabRefs.current.set(p.id, el)
              else tabRefs.current.delete(p.id)
            }}
            onClick={() => onSelect(p.id)}
            onKeyDown={event => {
              if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              moveWithKeyboard(p.id, event.key === 'ArrowLeft' ? -1 : 1)
            }}
            aria-posinset={projects.indexOf(p) + 1}
            aria-setsize={projects.length}
            title={`${p.name}\n${abbreviatePath(p.path)}`}
            className={active ? 'bs-tab bs-tab--active' : 'bs-tab'}
            role="tab"
            aria-selected={active}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 12px',
              height: '100%',
              maxWidth: 240,
              background: active ? 'var(--bs-bg-elev)' : 'transparent',
              color: 'var(--bs-fg)',
              opacity: active ? 1 : 0.55,
              fontWeight: active ? 500 : 400,
              border: 'none',
              borderRight: 'none',
              borderTop: active ? '2px solid var(--bs-blue)' : '2px solid transparent',
              borderBottom: active ? '2px solid var(--bs-blue)' : '2px solid transparent',
              fontFamily: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {p.name}
            </span>
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                flexShrink: 0,
                borderRadius: '50%',
                background: p.hasBeads
                  ? active
                    ? 'var(--bs-blue)'
                    : 'var(--bs-border)'
                  : 'transparent',
                border: p.hasBeads ? 'none' : '1px solid var(--bs-border)',
              }}
            />
            <TabStatusDot projectId={p.id} />
            {!active && waitingWorkspaces.has(p.id) && <span className="bs-notification-dot" data-workspace-notification={p.id} role="img" aria-label="a pane is waiting" />}
          </button>
          {onClose && <button onClick={() => onClose(p.id)} aria-label={`Close workspace ${p.name}`} title="Close workspace and stop its terminals" style={{ border: 0, background: 'transparent', color: 'var(--bs-fg-muted)', padding: '0 8px', cursor: 'pointer' }}><span className="codicon codicon-close" aria-hidden /></button>}
          </div>
        )
      })}
      {onOpen && <button onClick={onOpen} aria-label="Open workspace" title="Open workspace" style={{ border: 0, background: 'transparent', color: 'var(--bs-blue)', padding: '0 12px', cursor: 'pointer', flexShrink: 0 }}><span className="codicon codicon-add" aria-hidden /></button>}
    </div>
    {overflowing && <div data-tab-overflow style={{ display: 'flex', flexShrink: 0 }}>
      <button
        type="button"
        aria-label={`All workspaces (${projects.length})`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Show every workspace"
        onClick={() => setMenuOpen(open => !open)}
        style={{ border: 0, borderLeft: '1px solid var(--bs-border)', background: 'transparent', color: 'var(--bs-fg)', padding: '0 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}
      >
        <span aria-hidden>»</span><span style={{ color: 'var(--bs-fg-muted)' }}>{projects.length}</span>
        {projects.some(p => p.id !== activeId && waitingWorkspaces.has(p.id)) && <span className="bs-notification-dot" role="img" aria-label="a pane is waiting" />}
      </button>
      {menuOpen && <div role="menu" aria-label="Workspaces" style={{ position: 'absolute', right: 0, top: '100%', zIndex: 40, minWidth: 220, maxWidth: 360, maxHeight: '60vh', overflowY: 'auto', background: 'var(--bs-bg-elev)', border: '1px solid var(--bs-border)', borderRadius: 4, padding: 4, boxShadow: '0 6px 20px rgba(0,0,0,.35)' }}>
        {projects.map(p => {
          const active = p.id === activeId
          return <button key={p.id} role="menuitemradio" aria-checked={active} title={`${p.name}\n${abbreviatePath(p.path)}`}
            onClick={() => { setMenuOpen(false); onSelect(p.id) }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 0, background: active ? 'var(--bs-bg)' : 'transparent', color: 'var(--bs-fg)', fontFamily: 'inherit', fontSize: 12, padding: '5px 8px', borderRadius: 3, cursor: 'pointer' }}>
            <span aria-hidden style={{ width: 12, color: 'var(--bs-blue)' }}>{active && <span className="codicon codicon-check" />}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            {!active && waitingWorkspaces.has(p.id) && <span className="bs-notification-dot" role="img" aria-label="a pane is waiting" />}
          </button>
        })}
      </div>}
    </div>}
    </div>
  )
}
