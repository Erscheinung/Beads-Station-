// Phase 6 — Hook events drawer.
//
// A collapsible panel that lives ABOVE the main chat scroll. Hook frames
// (anything Claude CLI emits with type === 'hook' OR
// subtype ∈ {pre_tool_use, post_tool_use}) get partitioned out of the main
// transcript and into this drawer so they don't drown out assistant messages.
//
// State (open/closed) is persisted per-project via sessionStorage under
// `beads-station.drawer.${projectId}` so a tab swap doesn't flap the drawer.

import { useEffect, useState } from 'react'

export interface HookEvent {
  hookName: string
  tool?: string | null
  detail: string
}

interface ToolDrawerProps {
  projectId: string
  events: HookEvent[]
}

const STORAGE_PREFIX = 'beads-station.drawer.'

function readPersisted(projectId: string): boolean {
  try {
    return sessionStorage.getItem(STORAGE_PREFIX + projectId) === '1'
  } catch {
    return false
  }
}

function writePersisted(projectId: string, open: boolean): void {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + projectId, open ? '1' : '0')
  } catch {
    /* noop */
  }
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

// Convert any frame into a HookEvent for rendering. Pure helper exported for
// ClaudeChat's partitioning logic so the drawer doesn't need to know about
// raw stream-json shapes.
export function frameToHookEvent(frame: unknown): HookEvent | null {
  if (!frame || typeof frame !== 'object') return null
  const f = frame as Record<string, unknown>
  const isHook =
    f.type === 'hook' ||
    f.subtype === 'pre_tool_use' ||
    f.subtype === 'post_tool_use'
  if (!isHook) return null
  const hookName =
    (typeof f.hook_event_name === 'string' && f.hook_event_name) ||
    (typeof f.hook === 'string' && f.hook) ||
    (typeof f.subtype === 'string' && f.subtype) ||
    'hook'
  const tool =
    (typeof f.tool_name === 'string' && f.tool_name) ||
    (typeof f.tool === 'string' && f.tool) ||
    null
  const payload = f.input ?? f.output ?? f.tool_input ?? f.tool_response ?? f.data ?? null
  let detail = ''
  if (payload != null) {
    try {
      detail = typeof payload === 'string' ? payload : JSON.stringify(payload)
    } catch {
      detail = String(payload)
    }
  }
  return { hookName: String(hookName), tool, detail: trunc(detail, 80) }
}

export function ToolDrawer({ projectId, events }: ToolDrawerProps) {
  const [open, setOpen] = useState<boolean>(() => readPersisted(projectId))

  // Re-hydrate on projectId change (so switching tabs picks up the right
  // persisted state). Without this, switching projects keeps stale state.
  useEffect(() => {
    setOpen(readPersisted(projectId))
  }, [projectId])

  const toggle = () => {
    setOpen(o => {
      const next = !o
      writePersisted(projectId, next)
      return next
    })
  }

  const count = events.length

  return (
    <div className="bs-claude-drawer">
      <div
        className="bs-claude-drawer-header"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
        aria-expanded={open}
      >
        <span aria-hidden="true">{open ? '▼' : '›'}</span>
        <span>hook events ({count})</span>
      </div>
      {open && (
        <div className="bs-claude-drawer-body">
          {count === 0 ? (
            <div className="bs-claude-drawer-row" style={{ color: 'var(--bs-fg-faint)' }}>
              (no hook events yet)
            </div>
          ) : (
            events.map((ev, i) => (
              <div className="bs-claude-drawer-row" key={i} title={ev.detail}>
                {ev.hookName} · {ev.tool ?? '·'} · {ev.detail || '(no detail)'}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
