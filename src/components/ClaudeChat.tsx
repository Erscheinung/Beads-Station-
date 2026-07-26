// Phase 6 — ClaudeChat with tool-surface drawer + inline approval cards +
// cost meter + bd-prime system-reminder injection.
//
// The pre-Phase-6 ClaudeChat was a flat per-project stream-json bridge with
// a status dot and a stderr pass-through. Phase 6 deepens it without
// changing the prop surface (App.tsx still mounts <ClaudeChat key={id}
// projectId/cwd/sessionId/permissionMode/>):
//
//   * On mount we ask the backend for `bd prime` stdout, prepend it as a
//     synthetic system-reminder frame (locally), and ALSO send it to the
//     model as a user-role message so the running session sees the rules.
//   * Hook frames (type==='hook' OR subtype matches pre/post_tool_use) get
//     partitioned out of the main scroll into a collapsible <ToolDrawer>.
//   * Permission-request frames render an inline <ApprovalCard> at their
//     position in the scroll. Approve/Deny buttons fire the new
//     claude_approve/claude_deny commands; keyboard shortcut a/d resolves
//     the topmost pending card when the chat pane is focused.
//   * <CostMeter projectId={projectId}/> sits between the scroll body and
//     the input form, accumulating tokens + USD as result frames land.
//   * The 24px header keeps a stable slot at #bs-claude-header-right that
//     <PermissionModePicker> portals into.

import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { safeListen } from '../lib/safeListen'
import { ToolDrawer, frameToHookEvent, type HookEvent } from './ToolDrawer'
import { ApprovalCard, type ApprovalStatus } from './ApprovalCard'
import { CostMeter } from './CostMeter'
import { accumulate as accumulateUsage } from '../state/claudeUsage'
import { useVim } from '../state/vim'
import { PermissionModePicker } from '../state/claudeSettings'
import { setInsert as setTermInsert } from '../state/termPanes'

type Frame = any

interface ClaudeChatProps {
  projectId: string
  cwd: string
  sessionId: string
  permissionMode?: 'acceptEdits' | 'default' | 'plan'
  /**
   * RV2 — pane-scoped session identity. Defaults to projectId (legacy single
   * chat, byte-identical wire format). Agent panes pass a distinct bridgeId so
   * two panes on the same project never collide on events/usage/status/portal.
   */
  bridgeId?: string
  /**
   * RV2 — whether this instance owns the global a/d approval keydown listener.
   * Legacy chat leaves it undefined (gate unchanged). Agent panes pass their
   * focused state so only the active pane resolves an approval (G1).
   */
  active?: boolean
}

type StartStatus = 'pending' | 'started' | 'frame' | 'failed'

interface PendingApproval {
  requestId: string
  toolName: string
  input: unknown
  status: ApprovalStatus
}

// Pull a request_id out of a permission_request frame — defensively across
// the three plausible shapes the Claude CLI might use:
//   1. { type: 'permission_request', request_id, tool_name, input }
//   2. { subtype: 'permission_request', request_id, tool_name, input }
//   3. { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }
// Returns null if no permission shape can be extracted, in which case the
// frame falls through to the default render path.
function extractApproval(frame: any): PendingApproval | null {
  if (!frame || typeof frame !== 'object') return null
  if (frame.type === 'permission_request' || frame.subtype === 'permission_request') {
    const requestId =
      typeof frame.request_id === 'string'
        ? frame.request_id
        : typeof frame.id === 'string'
        ? frame.id
        : null
    if (!requestId) return null
    return {
      requestId,
      toolName: String(frame.tool_name ?? frame.tool ?? 'unknown'),
      input: frame.input ?? frame.tool_input ?? null,
      status: 'pending',
    }
  }
  // Tool-use shape — only treat as a request when permission mode is default
  // and the parent transcript is going to gate on it. We surface the card
  // unconditionally; if the CLI proceeds without waiting, the user can
  // still resolve it manually and the BE round-trip is a no-op.
  if (frame.type === 'assistant' && frame.message?.content) {
    const parts = Array.isArray(frame.message.content) ? frame.message.content : []
    const tu = parts.find((p: any) => p?.type === 'tool_use' && typeof p?.id === 'string')
    if (tu) {
      return {
        requestId: tu.id,
        toolName: String(tu.name ?? 'unknown'),
        input: tu.input ?? null,
        status: 'pending',
      }
    }
  }
  return null
}

function isHookFrame(frame: any): boolean {
  if (!frame || typeof frame !== 'object') return false
  if (frame.type === 'hook') return true
  if (frame.type === 'system') {
    return frame.subtype === 'hook_started' || frame.subtype === 'hook_response'
  }
  if (frame.subtype === 'pre_tool_use' || frame.subtype === 'post_tool_use') return true
  return false
}

function isEditableFocus(): boolean {
  const el = document.activeElement
  if (!el || !(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

export function ClaudeChat({ projectId, cwd, sessionId, permissionMode, bridgeId, active }: ClaudeChatProps) {
  // RV2 — every claude-session-scoped key (events, usage, status, approval
  // RPCs, header portal id) uses `bridge`. The REAL projectId is kept only for
  // project-scoped RPCs (projects_get) and the header label.
  const bridge = bridgeId ?? projectId
  const [frames, setFrames] = useState<Frame[]>([])
  const [hookEvents, setHookEvents] = useState<HookEvent[]>([])
  const [approvalStates, setApprovalStates] = useState<Record<string, ApprovalStatus>>({})
  const [evictedCount, setEvictedCount] = useState(0)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<StartStatus>('pending')
  const [stderrCount, setStderrCount] = useState(0)
  const vim = useVim()
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Resolve approvals to refs so the global keydown listener doesn't capture
  // a stale snapshot. This is the same trick useVimNav uses for vim state.
  const framesRef = useRef<Frame[]>([])
  framesRef.current = frames
  const approvalsRef = useRef<Record<string, ApprovalStatus>>({})
  approvalsRef.current = approvalStates

  // R2 §5a — bounded frames collection. Cap at 500; when appending overflows,
  // trim to the last 500, tally eviction, and GC approvalStates keys whose
  // requestId no longer appears in the surviving frames. GC runs in the same
  // event handler right after the setFrames call (functional setApprovalStates
  // keeps only live keys), so no orphan approval state can linger past eviction.
  const FRAME_CAP = 500
  const appendFrame = (next: Frame) => {
    setFrames(prev => {
      const merged = [...prev, next]
      if (merged.length > FRAME_CAP) {
        const dropped = merged.length - FRAME_CAP
        const trimmed = merged.slice(-FRAME_CAP)
        setEvictedCount(c => c + dropped)
        // GC approvalStates: keep only keys whose requestId still appears.
        const live = new Set<string>()
        for (const f of trimmed) {
          const a = extractApproval(f)
          if (a) live.add(a.requestId)
        }
        setApprovalStates(s => {
          const kept: Record<string, ApprovalStatus> = {}
          for (const k of Object.keys(s)) if (live.has(k)) kept[k] = s[k]
          return kept
        })
        return trimmed
      }
      return merged
    })
  }

  useEffect(() => {
    console.info('[ClaudeChat] starting', { projectId, cwd, sessionId, permissionMode })
    const ac = new AbortController()
    const { signal } = ac
    ;(async () => {
      let sid = sessionId
      if (!sid) {
        try {
          const proj = await invoke<{ claudeSessionId: string }>('projects_get', { id: projectId })
          sid = proj.claudeSessionId
        } catch (e) {
          console.error('projects_get failed', e)
        }
      }
      if (signal.aborted) return
      try {
        await invoke('claude_start', {
          projectId: bridge,
          cwd,
          sessionId: sid,
          permissionMode: permissionMode ?? 'acceptEdits',
        })
        if (!signal.aborted) setStatus('started')
      } catch (e) {
        console.error('claude_start failed', e)
        if (!signal.aborted) {
          setStatus('failed')
          appendFrame({ _kind: 'stderr', line: 'claude_start failed: ' + String(e) })
          setStderrCount(c => c + 1)
        }
      }
      if (signal.aborted) return

      // Phase 6 — fetch bd prime and inject as a system-reminder. Non-fatal
      // on error so a missing/broken bd doesn't keep the chat from working.
      // Use plain invoke (not safeInvoke): the local catch already handles
      // failure as non-fatal, and safeInvoke would ALSO push a user-facing
      // toast on every failure — which spams once per agent pane / per project
      // switch when bd is slow or queued behind the bd-spawn guard (RV2 made
      // this visible: N panes = N ClaudeChat mounts = N bd_prime calls).
      try {
        const bdPrimeOut = await invoke<string>('bd_prime', { repoPath: cwd })
        if (!signal.aborted && bdPrimeOut && bdPrimeOut.trim()) {
          const reminder = `<system-reminder>\nBeads workflow primer (auto-injected on session open):\n\n${bdPrimeOut}\n</system-reminder>`
          appendFrame({ _kind: 'system-reminder', text: bdPrimeOut })
          // Send the reminder text as a user message so the running session
          // sees the rules. Wrapped in <system-reminder> tags by convention.
          try {
            await invoke('claude_send', { projectId: bridge, text: reminder })
          } catch (e) {
            console.warn('[ClaudeChat] bd-prime claude_send failed (non-fatal)', e)
          }
        }
      } catch (e) {
        console.warn('[ClaudeChat] bd_prime failed (non-fatal)', e)
      }

      await safeListen<Frame>(`claude_event:${bridge}`, e => {
        const frame = e.payload
        // Always feed the usage accumulator; it ignores frames it can't use.
        accumulateUsage(bridge, frame)
        if (isHookFrame(frame)) {
          const hev = frameToHookEvent(frame)
          if (hev) setHookEvents(h => [...h, hev].slice(-200))
          // Don't push hook frames into the main scroll.
          setStatus(s => (s === 'failed' ? s : 'frame'))
          return
        }
        appendFrame(frame)
        setStatus(s => (s === 'failed' ? s : 'frame'))
      }, signal)
      await safeListen<string>(`claude_event_raw:${bridge}`, e => {
        appendFrame({ _kind: 'raw', line: String(e.payload) })
      }, signal)
      await safeListen<string>(`claude_stderr:${bridge}`, e => {
        appendFrame({ _kind: 'stderr', line: String(e.payload) })
        setStderrCount(c => c + 1)
      }, signal)
    })()
    return () => {
      ac.abort()
      // Phase 6 manages claude lifecycles — do NOT auto-kill on unmount.
    }
  }, [projectId, bridge, cwd, sessionId, permissionMode])

  // RV2 — agent panes autofocus their input once mounted. App.tsx's spawn
  // handler used to call setInsert(true) synchronously, before this input
  // existed in the DOM, so the focus landed nowhere and the user was "stuck"
  // typing into the void. Focusing here (post-mount) fires onFocus ->
  // setTermInsert(true), tying the insert mirror to real focus. Only for agent
  // panes (bridgeId set); the legacy grid chat must not steal focus on boot.
  useEffect(() => {
    if (bridgeId == null) return
    // rAF: run after the browser has committed layout so .focus() sticks.
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [bridgeId])

  // Compute the topmost-pending approval for the keyboard shortcut. Walk
  // frames in order; the first frame that yields an extractable approval
  // whose state is 'pending' wins.
  const topmostPending = useMemo<PendingApproval | null>(() => {
    for (const f of frames) {
      const a = extractApproval(f)
      if (!a) continue
      const state = approvalStates[a.requestId] ?? 'pending'
      if (state === 'pending') return a
    }
    return null
  }, [frames, approvalStates])

  // Keyboard shortcut: a / d when chat is focused and a pending approval
  // exists. Bypass when an editable element (the input field) has focus.
  useEffect(() => {
    // RV2 — an agent pane passes active=false when it's not the focused pane,
    // so only one instance resolves an approval (G1). Legacy chat leaves it
    // undefined (=> gate unchanged).
    if (vim.focused !== 'chat') return
    if (active === false) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableFocus()) return
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      const key = event.key
      if (key !== 'a' && key !== 'd') return
      // Read the latest frames+states from refs (closure may be stale).
      let pending: PendingApproval | null = null
      for (const f of framesRef.current) {
        const a = extractApproval(f)
        if (!a) continue
        const state = approvalsRef.current[a.requestId] ?? 'pending'
        if (state === 'pending') { pending = a; break }
      }
      if (!pending) return
      event.preventDefault()
      const decide = key === 'a' ? 'approved' : 'denied'
      const cmd = key === 'a' ? 'claude_approve' : 'claude_deny'
      setApprovalStates(s => ({ ...s, [pending!.requestId]: decide }))
      invoke(cmd, { projectId: bridge, requestId: pending.requestId }).catch(err => {
        console.error('[ClaudeChat] approval rpc failed', err)
        setApprovalStates(s => ({ ...s, [pending!.requestId]: 'pending' }))
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [vim.focused, projectId, bridge, active])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    appendFrame({ _local: true, role: 'user', text })
    setInput('')
    try { await invoke('claude_send', { projectId: bridge, text }) } finally { setBusy(false) }
  }

  // Status dot — same logic as pre-Phase-6.
  const dotColor =
    status === 'failed' || stderrCount > 0 ? 'var(--bs-red)'
    : status === 'frame' ? 'var(--bs-green)'
    : 'var(--bs-yellow)'

  const onResolveApproval = (requestId: string, next: 'approved' | 'denied') => {
    setApprovalStates(s => ({ ...s, [requestId]: next }))
  }

  return (
    <div data-bs-agent-pane={bridge} style={{ display: 'flex', flexDirection: 'column', height: '100%', borderTop: '1px solid var(--bs-border)' }}>
      <div style={{
        height: 24, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11, color: 'var(--bs-fg)', opacity: 0.85,
        borderBottom: '1px solid var(--bs-border)', background: 'var(--bs-bg-elev)',
      }}>
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          background: dotColor, flexShrink: 0,
        }} />
        <span style={{ opacity: 0.7 }}>claude · {projectId}</span>
        {/* Stable slot for PermissionModePicker — bridge-scoped id so two
            ClaudeChat instances never portal into one node (getElementById
            returns only the first match). */}
        <span id={`bs-claude-header-right-${bridge}`} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }} />
        {/* Agent panes own their picker in-header (App.tsx mounts it only for
            the legacy grid chat). bridgeId set => agent-pane mode. */}
        {bridgeId != null && <PermissionModePicker projectId={projectId} bridgeId={bridge} />}
      </div>

      <ToolDrawer projectId={bridge} events={hookEvents} />

      <div className="bs-chat-scroll" style={{ flex: 1, overflowY: 'auto', padding: 12, fontSize: 12, lineHeight: 1.5 }}>
        {evictedCount > 0 && (
          <div style={{ color: 'var(--bs-fg-muted)', fontSize: 11, padding: '2px 0 8px', opacity: 0.7 }}>— {evictedCount} earlier frames evicted —</div>
        )}
        {frames.map((f, i) => {
          if (f?._kind === 'system-reminder') {
            return (
              <div key={i} className="bs-system-reminder">
                {String(f.text ?? '')}
              </div>
            )
          }
          // Approval card — render in place if this frame yields one.
          const a = extractApproval(f)
          if (a) {
            const state = approvalStates[a.requestId] ?? 'pending'
            return (
              <ApprovalCard
                key={`approval-${i}-${a.requestId}`}
                projectId={bridge}
                requestId={a.requestId}
                toolName={a.toolName}
                input={a.input}
                status={state}
                onResolve={next => onResolveApproval(a.requestId, next)}
              />
            )
          }
          const style: React.CSSProperties = { margin: '0 0 8px 0', whiteSpace: 'pre-wrap' }
          if (f?._kind === 'stderr') { style.color = 'var(--bs-red)'; style.opacity = 0.8 }
          else if (f?._kind === 'raw') { style.color = 'var(--bs-yellow)'; style.opacity = 0.8 }
          return <pre key={i} style={style}>{renderFrame(f)}</pre>
        })}
      </div>

      <CostMeter projectId={bridge} />

      <form onSubmit={e => { e.preventDefault(); send() }} style={{ display: 'flex', gap: 8, padding: 8, borderTop: '1px solid var(--bs-border)' }}>
        <input
          ref={inputRef}
          data-bs-agent-input
          value={input}
          onChange={e => setInput(e.target.value)}
          // RV2 — for agent panes (bridgeId set), the input's REAL focus is the
          // source of truth for insert mode. Binding onFocus/onBlur keeps the
          // termPanes `insert` mirror in sync no matter how focus was acquired
          // (click, spawn autofocus, tab), so useVimNav's Esc/leader routing
          // doesn't desync. Esc blurs locally (belt-and-suspenders with the
          // window handler) so the user is never trapped typing.
          onFocus={bridgeId != null ? () => setTermInsert(true) : undefined}
          onBlur={bridgeId != null ? () => setTermInsert(false) : undefined}
          onKeyDown={bridgeId != null ? e => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setTermInsert(false)
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          } : undefined}
          placeholder={topmostPending ? `pending: approve(a)/deny(d) ${topmostPending.toolName}` : 'ask claude'}
          disabled={busy}
          style={{ flex: 1, background: 'var(--bs-bg-elev)', color: 'var(--bs-fg)', border: '1px solid var(--bs-border)', padding: '6px 8px', fontFamily: 'inherit' }}
        />
        <button type="submit" disabled={busy} style={{ background: 'var(--bs-blue)', color: 'var(--bs-bg-dark)', border: 'none', padding: '6px 12px', fontFamily: 'inherit', cursor: 'pointer' }}>send</button>
      </form>
    </div>
  )
}

function renderFrame(f: any): string {
  if (f?._local) return `> ${f.text}`
  if (f?._kind === 'stderr') return `[stderr] ${f.line}`
  if (f?._kind === 'raw') return `[raw] ${f.line}`
  if (f?.type === 'assistant' && f?.message?.content) {
    const parts = Array.isArray(f.message.content) ? f.message.content : []
    return parts.map((p: any) => p?.type === 'text' ? p.text : JSON.stringify(p)).join('\n')
  }
  if (f?.type === 'system') return `[system] ${f?.subtype ?? ''}`
  if (f?.type === 'result') return `[result] ${f?.subtype ?? ''}`
  return JSON.stringify(f).slice(0, 400)
}
