import { useEffect, useRef } from 'react'
import type { Project } from '../state/projects'
import { useClaudeStatus, type ClaudeStatus } from '../state/claudeStatus'

interface TabBarProps {
  projects: Project[]
  activeId: string | null
  onSelect: (id: string) => void
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
 * colors. Each tab is capped at 160px and truncates with an ellipsis. Active
 * tab gets a solid bottom-border in --bs-blue, raised --bs-bg-elev background
 * and brightened foreground; inactive tabs sit muted with a transparent
 * bottom border so the active swap doesn't shift layout. Overflow scrolls
 * horizontally with a thin custom scrollbar, and the active tab is scrolled
 * into view on selection change.
 */
export function TabBar({ projects, activeId, onSelect }: TabBarProps) {
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  useEffect(() => {
    if (!activeId) return
    const el = tabRefs.current.get(activeId)
    if (el) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }
  }, [activeId])

  return (
    <div
      className="bs-tabstrip"
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'stretch',
        height: 32,
        background: 'var(--bs-bg)',
        borderBottom: '1px solid var(--bs-border)',
        overflowX: 'auto',
        overflowY: 'hidden',
        flexShrink: 0,
      }}
    >
      {projects.map(p => {
        const active = p.id === activeId
        return (
          <button
            key={p.id}
            ref={el => {
              if (el) tabRefs.current.set(p.id, el)
              else tabRefs.current.delete(p.id)
            }}
            onClick={() => onSelect(p.id)}
            title={p.path}
            className={active ? 'bs-tab bs-tab--active' : 'bs-tab'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 12px',
              height: '100%',
              maxWidth: 160,
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
          </button>
        )
      })}
    </div>
  )
}
