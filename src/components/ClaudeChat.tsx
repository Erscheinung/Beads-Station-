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
import { chanId } from '../lib/eventChannel'
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
  // Code-x5l: true when this came from a real permission_request frame (path 1),
  // false when synthesized from an assistant tool_use (path 2). Path-1 approvals
  // have no tool_use↔tool_result pair to fall back to, so on resolve they must
  // render the resolved ApprovalCard variant rather than unmounting. Path-2
  // resolves flip into the rich render tree as a pair, so their card unmounts.
  isPermissionFrame: boolean
}

// Pull a request_id out of a permission_request frame — defensively across
// the three plausible shapes the Claude CLI might use:
//   1. { type: 'permission_request', request_id, tool_name, input }
//   2. { subtype: 'permission_request', request_id, tool_name, input }
//   3. { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }
// Returns null if no permission shape can be extracted, in which case the
// frame falls through to the default render path.
//
// Code-nfs: shapes 1-2 are REAL permission gates from the CLI and always yield
// an approval. Shape 3 (a plain assistant tool_use) is only a gate when the CLI
// is actually going to pause for it — i.e. permissionMode === 'default'. In
// acceptEdits / bypassPermissions / plan modes the CLI runs tools without
// asking, so surfacing an ApprovalCard for every tool_use was wrong (it dangled
// a pending card the user had to dismiss for a tool that already ran). Callers
// pass `treatToolUseAsApproval = permissionMode === 'default'`.
function extractApproval(frame: any, treatToolUseAsApproval = true): PendingApproval | null {
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
      isPermissionFrame: true,
    }
  }
  // Tool-use shape — only a real gate when permissionMode === 'default'. Other
  // modes auto-run the tool, so we must NOT surface an approval card for it.
  if (treatToolUseAsApproval && frame.type === 'assistant' && frame.message?.content) {
    const parts = Array.isArray(frame.message.content) ? frame.message.content : []
    const tu = parts.find((p: any) => p?.type === 'tool_use' && typeof p?.id === 'string')
    if (tu) {
      return {
        requestId: tu.id,
        toolName: String(tu.name ?? 'unknown'),
        input: tu.input ?? null,
        status: 'pending',
        isPermissionFrame: false,
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
  // Code-nfs: a plain assistant tool_use is only a real approval gate when the
  // CLI will actually pause for it — permissionMode === 'default'. In other
  // modes tools auto-run, so tool_use frames must not spawn ApprovalCards.
  // Real permission_request frames are always honored regardless of mode.
  const gateToolUse = (permissionMode ?? 'acceptEdits') === 'default'
  const [frames, setFrames] = useState<Frame[]>([])
  const [hookEvents, setHookEvents] = useState<HookEvent[]>([])
  const [approvalStates, setApprovalStates] = useState<Record<string, ApprovalStatus>>({})
  const [evictedCount, setEvictedCount] = useState(0)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<StartStatus>('pending')
  const [stderrCount, setStderrCount] = useState(0)
  // Respawn attempt counter — resets to 0 on a successful frame (session live).
  // Capped at 3 so a persistent exit loop (bad auth, wrong cwd) stops after 3.
  const respawnAttemptsRef = useRef(0)
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
  // requestId no longer appears in the surviving frames.
  //
  // Code-1cs (F3): the eviction tally + approval GC used to run from INSIDE the
  // setFrames updater. Updaters must be pure — React double-invokes them under
  // StrictMode, and scheduling sibling setStates inside schedules extra renders
  // during frame bursts. We now decide the trim against a ref mirror of the
  // current frames (framesRef, kept in sync every render), do the setState side
  // effects OUTSIDE the updater, and hand setFrames a plain value.
  const FRAME_CAP = 500
  const appendFrame = (next: Frame) => {
    const merged = [...framesRef.current, next]
    if (merged.length > FRAME_CAP) {
      const dropped = merged.length - FRAME_CAP
      const trimmed = merged.slice(-FRAME_CAP)
      // GC approvalStates: keep only keys whose requestId still appears.
      const live = new Set<string>()
      for (const f of trimmed) {
        const a = extractApproval(f, gateToolUse)
        if (a) live.add(a.requestId)
      }
      framesRef.current = trimmed
      setFrames(trimmed)
      setEvictedCount(c => c + dropped)
      setApprovalStates(s => {
        const kept: Record<string, ApprovalStatus> = {}
        for (const k of Object.keys(s)) if (live.has(k)) kept[k] = s[k]
        return kept
      })
      return
    }
    framesRef.current = merged
    setFrames(merged)
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

      // Code-lbi: register ALL listeners BEFORE claude_start so no early frames
      // (startup diagnostic, initial stderr, session-id) are lost to the race.
      await safeListen<Frame>(`claude_event:${chanId(bridge)}`, e => {
        const frame = e.payload
        // Session is alive — reset the respawn counter.
        respawnAttemptsRef.current = 0
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
      await safeListen<string>(`claude_event_raw:${chanId(bridge)}`, e => {
        appendFrame({ _kind: 'raw', line: String(e.payload) })
      }, signal)
      await safeListen<string>(`claude_stderr:${chanId(bridge)}`, e => {
        appendFrame({ _kind: 'stderr', line: String(e.payload) })
        setStderrCount(c => c + 1)
      }, signal)
      // Code-key: listen for child-exit status to trigger respawn.
      // Use the resumeKey from the outer scope so respawn goes through the
      // same persisted-id logic as the initial mount (not a stale closure).
      const resumeKey = `bs.claude.session:${bridge}`
      await safeListen<string>(`claude_status:${chanId(bridge)}`, e => {
        if (e.payload === 'exited') {
          respawnAttemptsRef.current += 1
          if (respawnAttemptsRef.current > 3) {
            appendFrame({ _kind: 'stderr', line: '[session exited — too many respawn attempts, giving up]' })
            setStderrCount(c => c + 1)
            setStatus('failed')
            return
          }
          setStatus('failed')
          appendFrame({ _kind: 'stderr', line: '[session exited — respawning…]' })
          setStderrCount(c => c + 1)
          // Clear any persisted session id before respawn: if the exit was
          // caused by "Session ID already in use" (another terminal owns it),
          // re-passing the same id would loop forever.
          localStorage.removeItem(resumeKey)
          const delay = Math.min(500 * respawnAttemptsRef.current, 2000)
          setTimeout(() => {
            invoke('claude_start', {
              projectId: bridge, cwd,
              sessionId: '',
              permissionMode: permissionMode ?? 'acceptEdits',
              resume: false,
            }).catch(err => console.error('[ClaudeChat] auto-respawn failed', err))
          }, delay)
        }
      }, signal)
      // Code-lbi: replay scrollback ring so frames emitted before listener
      // registration (startup diagnostic, session preamble) are not lost.
      try {
        const buffered = await invoke<Frame[]>('claude_get_scrollback', { projectId: bridge })
        if (!signal.aborted && buffered.length > 0) {
          for (const frame of buffered) {
            accumulateUsage(bridge, frame)
            if (!isHookFrame(frame)) appendFrame(frame)
          }
          setStatus(s => (s === 'pending' ? 'frame' : s))
        }
      } catch (_) { /* non-fatal */ }

      if (signal.aborted) return
      // Code-4je: check for a persisted CLI-assigned session_id to resume.
      // resumeKey declared above (shared with the exit-monitor listener).
      const persistedSid = localStorage.getItem(resumeKey)
      const useResume = !!persistedSid
      const startSid = persistedSid ?? sid
      try {
        await invoke('claude_start', {
          projectId: bridge,
          cwd,
          sessionId: startSid,
          permissionMode: permissionMode ?? 'acceptEdits',
          resume: useResume,
        })
        if (!signal.aborted) setStatus('started')
        // After start, give the init frame a moment to arrive then capture
        // the CLI-assigned session_id and persist it for resume.
        if (!signal.aborted && !useResume) {
          setTimeout(async () => {
            try {
              const cliSid = await invoke<string | null>('claude_get_session_id', { projectId: bridge })
              if (cliSid) localStorage.setItem(resumeKey, cliSid)
            } catch (_) { /* non-fatal */ }
          }, 2000)
        }
      } catch (e) {
        console.error('claude_start failed', e)
        if (!signal.aborted) {
          setStatus('failed')
          appendFrame({ _kind: 'stderr', line: 'claude_start failed: ' + String(e) })
          setStderrCount(c => c + 1)
        }
      }
      if (signal.aborted) return

      // Phase 6 removed (Code-x5o / Code-5uy): the SessionStart hook in
      // .claude/settings.json already injects bd prime into every claude --print
      // session. Fetching + re-sending it here was a ~16KB cache-write duplicate
      // (~$0.40/pane first-turn cost) and added 0.4s for the bd subprocess on
      // every mount. Hook coverage is sufficient for all pane types.
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
      const a = extractApproval(f, gateToolUse)
      if (!a) continue
      const state = approvalStates[a.requestId] ?? 'pending'
      if (state === 'pending') return a
    }
    return null
  }, [frames, approvalStates, gateToolUse])

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

  // Code-1cs (F2): the pending-approval list used to be derived by an
  // un-memoized frames.map(extractApproval) in the JSX on every render, on top
  // of the memoized renderItems/topmostPending/resolvedToolIds passes that
  // already walk up to 500 frames. Fold the extraction into one memo (keeps the
  // original frame index for a stable React key). The render-time decision
  // (isApprovalPending / isPermissionFrame unmount rule) stays in the map below
  // since it depends on approvalStates, which changes independently.
  const approvalItems = useMemo(
    () => {
      const out: { approval: PendingApproval; index: number }[] = []
      frames.forEach((f, i) => {
        const a = extractApproval(f, gateToolUse)
        if (a) out.push({ approval: a, index: i })
      })
      return out
    },
    [frames, gateToolUse],
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
        const a = extractApproval(f, gateToolUse)
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
    [bridge, gateToolUse],
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
      // Code-key: broaden respawn trigger — "session dead" (broken pipe) OR
      // "session not started" (reconcile evicted it) both mean we need to respawn.
      if (msg.includes('session dead') || msg.includes('session not started')) {
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
            the newest (awaiting the user), so they sit at the tail.
            Code-nfs: gateToolUse decides whether a bare tool_use counts.
            Code-x5l: a real permission_request frame (isPermissionFrame) keeps
            its card mounted through the resolved state so the user sees the
            '[ok] approved' / '[x] denied' confirmation — it has no rich-tree
            pair to fall back to. A tool_use approval (path 2) still unmounts on
            resolve because it re-enters the render tree as a paired item. */}
        {approvalItems.map(({ approval: a, index: i }) => {
          const state = approvalStates[a.requestId] ?? 'pending'
          const pending = isApprovalPending(a.requestId)
          // Unmount once resolved UNLESS this is a real permission frame, which
          // must show its resolved confirmation (Code-x5l).
          if (!pending && !a.isPermissionFrame) return null
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
