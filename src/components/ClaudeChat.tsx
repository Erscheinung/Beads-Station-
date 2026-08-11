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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { safeListen } from '../lib/safeListen'
import { ToolDrawer, frameToHookEvent, type HookEvent } from './ToolDrawer'
import { ApprovalCard, type ApprovalStatus } from './ApprovalCard'
import { CostMeter } from './CostMeter'
import { accumulate as accumulateUsage } from '../state/claudeUsage'
import { useVim } from '../state/vim'
import { PermissionModePicker } from '../state/claudeSettings'
import { setInsert as setTermInsert } from '../state/termPanes'
import { buildRenderItems } from '../lib/renderItems'
import { RenderItemView } from './RenderItems'

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
      // RV2-fix (Code-51e): the LEGACY grid chat (bridgeId==null) is mounted
      // as <ClaudeChat key={active.id}>, so it unmounts on EVERY project
      // switch. It used to leave its backend claude session alive forever —
      // visiting N projects leaked N `claude --print` children, exhausting
      // forks until bd reads failed ("issues gone on project switch"). Kill
      // it on unmount. AGENT panes (bridgeId set) are intentionally NOT
      // killed here: they persist across project switches by design and are
      // reaped by explicit <leader>x or the app-exit CloseRequested handler.
      if (bridgeId == null) {
        invoke('claude_kill', { projectId: bridge }).catch(() => {})
      }
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

  // RV3-A — the set of tool_use ids that have already COMPLETED (a matching
  // tool_result frame arrived). A completed tool is never a pending approval:
  // it renders as a rich collapsible pair, not an ApprovalCard. This is what
  // lets a tool_use flip from ApprovalCard (while genuinely awaiting the user)
  // to a resolved pair (once it ran). Derived useMemo over frames — no new
  // unbounded array, getSnapshot stays cached (R2 discipline).
  const resolvedToolIds = useMemo<Set<string>>(() => {
    const s = new Set<string>()
    for (const f of frames) {
      if (f?.type === 'user' && Array.isArray(f?.message?.content)) {
        for (const p of f.message.content) {
          if (p?.type === 'tool_result' && typeof p?.tool_use_id === 'string') s.add(p.tool_use_id)
        }
      }
    }
    return s
  }, [frames])

  // A tool_use still "owns" an ApprovalCard only while it is genuinely
  // pending: no explicit approve/deny recorded AND no tool_result yet.
  const isApprovalPending = useMemo(
    () => (toolUseId: string) =>
      !resolvedToolIds.has(toolUseId) && (approvalStates[toolUseId] ?? 'pending') === 'pending',
    [resolvedToolIds, approvalStates],
  )

  // RV3-A — the rich render-item tree (paired tool_use↔tool_result, markdown,
  // diffs, recursive subagent chains). Pure pass, memoized over frames so the
  // bounded 500-cap append path stays the only writer.
  const renderItems = useMemo(
    () => buildRenderItems(frames, isApprovalPending),
    [frames, isApprovalPending],
  )

  // Resolve the topmost pending approval. Shared by the window-level a/d
  // shortcut (chat/pane focus, no editable) AND the agent input's own onKeyDown
  // (RV3.12 — an agent pane's input holds focus, so a/d never reached the
  // window listener; the placeholder promised approve(a)/deny(d) but the keys
  // were dead). Returns true if it resolved something.
  const resolveApproval = useCallback(
    (decision: 'approved' | 'denied'): boolean => {
      let pending: PendingApproval | null = null
      for (const f of framesRef.current) {
        const a = extractApproval(f)
        if (!a) continue
        const state = approvalsRef.current[a.requestId] ?? 'pending'
        if (state === 'pending') { pending = a; break }
      }
      if (!pending) return false
      const cmd = decision === 'approved' ? 'claude_approve' : 'claude_deny'
      const reqId = pending.requestId
      setApprovalStates(s => ({ ...s, [reqId]: decision }))
      invoke(cmd, { projectId: bridge, requestId: reqId }).catch(err => {
        console.error('[ClaudeChat] approval rpc failed', err)
        setApprovalStates(s => ({ ...s, [reqId]: 'pending' }))
      })
      return true
    },
    [bridge],
  )

  // Keyboard shortcut: a / d when chat is focused and a pending approval
  // exists. Bypass when an editable element (the input field) has focus.
  useEffect(() => {
    // RV2 — an agent pane passes active=false when it's not the focused pane,
    // so only one instance resolves an approval (G1). Legacy chat leaves it
    // undefined (=> gate unchanged).
    // RV3.12 — an agent pane lives in vim.focused==='terminal', NOT 'chat', so
    // gate on the explicit `active` flag when it's set (agent pane), and only
    // fall back to the vim.focused==='chat' check for the legacy chat
    // (active===undefined). Without this, agent-pane approvals were dead.
    const isAgentPane = active !== undefined
    if (isAgentPane) {
      if (active !== true) return
    } else if (vim.focused !== 'chat') {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableFocus()) return
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      const key = event.key
      if (key !== 'a' && key !== 'd') return
      if (resolveApproval(key === 'a' ? 'approved' : 'denied')) {
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [vim.focused, projectId, bridge, active, resolveApproval])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    appendFrame({ _local: true, role: 'user', text })
    setInput('')
    try {
      await invoke('claude_send', { projectId: bridge, text })
    } catch (e) {
      const msg = String(e)
      // A dead session (child exited on a bad endpoint since it was started)
      // surfaces as "session dead: ..." — the backend has already evicted it.
      // Respawn once and retry the send so the user doesn't have to reload.
      if (msg.includes('session dead')) {
        try {
          await invoke('claude_start', {
            projectId: bridge,
            cwd,
            sessionId: sessionId || undefined,
            permissionMode: permissionMode ?? 'acceptEdits',
          })
          await invoke('claude_send', { projectId: bridge, text })
          return
        } catch (e2) {
          console.error('claude respawn+resend failed', e2)
          appendFrame({ _kind: 'stderr', line: 'send failed (respawn): ' + String(e2) })
          setStderrCount(c => c + 1)
          return
        }
      }
      console.error('claude_send failed', e)
      appendFrame({ _kind: 'stderr', line: 'send failed: ' + msg })
      setStderrCount(c => c + 1)
    } finally {
      setBusy(false)
    }
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
        {/* RV3-A — rich render-item tree: markdown, paired tool_use↔tool_result,
            unified diffs, recursive subagent chains. Pending tool approvals are
            excluded here (isApprovalPending) and rendered as ApprovalCards below,
            so a tool flips ApprovalCard → resolved pair once it runs. */}
        {renderItems.map(item => (
          <RenderItemView key={item.key} item={item} />
        ))}
        {/* Pending approvals — the only frames NOT in renderItems. Chronologically
            the newest (awaiting the user), so they sit at the tail. */}
        {frames.map((f, i) => {
          const a = extractApproval(f)
          if (!a) return null
          const state = approvalStates[a.requestId] ?? 'pending'
          if (!isApprovalPending(a.requestId)) return null
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
              return
            }
            // RV3.12 — while a tool approval is pending and the input is empty,
            // a/d resolve it (the agent input holds focus, so the window-level
            // a/d listener's isEditableFocus() bypass would otherwise swallow
            // them — the placeholder promises approve(a)/deny(d)). Only when
            // empty, so typing an actual message starting with a/d still works.
            if (topmostPending && input.length === 0 && (e.key === 'a' || e.key === 'd')) {
              if (resolveApproval(e.key === 'a' ? 'approved' : 'denied')) {
                e.preventDefault()
                e.stopPropagation()
              }
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
