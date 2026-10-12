import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { safeListen } from '../../lib/listenerRegistry'
import { chanId } from '../../lib/eventChannel'

/**
 * Direct provider CLIs plus Code-da0.5 conductor backends. `codex-orchestrator`
 * runs Codex through the adaptive Sol/Luna orchestrator skill;
 * `opus-conductor` runs Claude Code through the Opus/Sonnet adaptive
 * orchestrator skill; `session` is an attempt submitted from a live session.
 */
export type NativeProvider = 'claude' | 'codex' | 'codex-orchestrator' | 'opus-conductor' | 'session'
export type NativeRunStatus = 'idle' | 'starting' | 'running' | 'needs_review' | 'failed' | 'cancelled' | 'unknown'
export interface NativeRunState {
  key: string
  runId: string | null
  workspaceId: string
  ticketId: string
  attemptId: string | null
  /** Exact workspace root supplied to the owned native child. */
  cwd: string
  provider: NativeProvider
  status: NativeRunStatus
  output: string[]
  /** Codex worker thread ids seen in this run; their activity is read on demand. */
  workers: string[]
}

export interface NativeRunEvent { seq: number; kind: string; status?: NativeRunStatus; line?: string; parsed?: unknown }
interface NativeRunSnapshot {
  runId: string
  workspaceId: string
  ticketId: string
  attemptId: string
  cwd?: string
  provider: NativeProvider
  status: NativeRunStatus
  events: NativeRunEvent[]
}

const STORAGE = 'beads-station.designer-runs.v1'
const listeners = new Set<() => void>()
const eventHistory = new Map<string, Map<number, NativeRunEvent>>()
const snapshotAuthorities = new Map<string, { seq: number; status: NativeRunStatus }>()
const keyGenerations = new Map<string, number>()
const subscriptions = new Map<string, AbortController>()
const reconciling = new Map<string, Promise<void>>()
let states = new Map<string, NativeRunState>()
const emptyStates = new Map<string, NativeRunState>()

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE) ?? '[]') as NativeRunState[]
  states = new Map(saved.map(run => [run.key, {
    ...run,
    workspaceId: run.workspaceId ?? run.key.split(':')[0] ?? '',
    ticketId: run.ticketId ?? '',
    attemptId: run.attemptId ?? null,
    cwd: run.cwd ?? '',
    workers: Array.isArray(run.workers) ? run.workers : [],
    status: run.status === 'running' || run.status === 'starting' ? 'unknown' : run.status,
  }]))
} catch { /* corrupt summaries do not block requests */ }

function emit() {
  try { localStorage.setItem(STORAGE, JSON.stringify([...states.values()].slice(-50))) } catch { /* current session still works */ }
  listeners.forEach(listener => listener())
}
function setRun(key: string, patch: Partial<NativeRunState>) {
  const current = states.get(key) ?? { key, runId: null, workspaceId: '', ticketId: '', attemptId: null, cwd: '', provider: 'claude', status: 'idle', output: [], workers: [] }
  states = new Map(states).set(key, { ...current, ...patch })
  emit()
}
const short = (text: unknown, limit = 240) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** A Codex collaboration item: the primary agent starting, waiting on or closing a worker. */
function collabText(item: any, phase: string): string | null {
  const tool = String(item.tool ?? '')
  const states = Object.values((item.agents_states ?? {}) as Record<string, { status?: string; message?: string | null }>)
  if (tool === 'spawn_agent') return phase === 'item.completed' ? `Worker started: ${short(item.prompt)}` : null
  if (tool === 'wait' || tool === 'wait_agent') {
    if (phase === 'item.started') return 'Waiting for the worker…'
    const reports = states.filter(state => state?.message).map(state => `Worker ${state.status ?? 'reported'}: ${short(state.message, 600)}`)
    return reports.length ? reports.join('\n') : null
  }
  if (tool === 'close_agent') return phase === 'item.completed' ? 'Worker closed.' : null
  if (tool === 'send_input' || tool === 'followup_task' || tool === 'send_message') return phase === 'item.completed' ? `To worker: ${short(item.prompt)}` : null
  return null
}

/** Claude Code content blocks. Lines from a subagent carry its parent tool call id. */
function claudeText(value: any): string | null {
  const blocks = value?.message?.content
  if (!Array.isArray(blocks)) return null
  const worker = value.parent_tool_use_id ? 'Worker: ' : ''
  const lines: string[] = []
  for (const block of blocks) {
    if (block?.type === 'text' && block.text) lines.push(`${worker}${block.text}`)
    else if (block?.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')) {
      lines.push(`Delegated to ${block.input?.subagent_type ?? 'a worker'}${block.input?.model ? ` (${block.input.model})` : ''}: ${short(block.input?.description ?? block.input?.prompt)}`)
    } else if (block?.type === 'tool_use' && worker) {
      // The primary agent's own tool calls stay out of the summary; a worker's
      // are the only sign of what it is doing until it reports back.
      const target = block.input?.file_path ?? block.input?.command ?? block.input?.pattern ?? ''
      lines.push(`${worker}→ ${block.name} ${short(target, 160)}`.trimEnd())
    }
  }
  return lines.length ? lines.join('\n') : null
}

export function eventText(event: NativeRunEvent): string | null {
  if (event.kind === 'stderr') return String(event.line ?? '')
  const value: any = event.parsed
  if (typeof value?.message === 'string') return value.message
  if (typeof value?.text === 'string') return value.text
  const claude = claudeText(value)
  if (claude) return claude
  const item = value?.item
  if (item?.type === 'collab_tool_call') return collabText(item, String(value.type ?? ''))
  if (item?.type === 'agent_message' && typeof item.text === 'string') return item.text
  return null
}

/** Thread ids of the Codex workers a run has started, in order of appearance. */
export function workerThreads(events: NativeRunEvent[]): string[] {
  const ids: string[] = []
  for (const event of events) {
    const item = (event.parsed as any)?.item
    if (item?.type !== 'collab_tool_call') continue
    for (const id of [...(item.receiver_thread_ids ?? []), ...Object.keys(item.agents_states ?? {})]) {
      if (typeof id === 'string' && /^[0-9a-f-]{8,64}$/i.test(id) && !ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

function mergeEvents(key: string, runId: string, incoming: NativeRunEvent[]) {
  const current = states.get(key)
  if (!current || current.runId !== runId) return
  const history = eventHistory.get(runId) ?? new Map<number, NativeRunEvent>()
  for (const event of incoming) if (Number.isSafeInteger(event?.seq)) history.set(event.seq, event)
  if (history.size > 200) {
    const oldest = [...history.keys()].sort((a, b) => a - b).slice(0, history.size - 200)
    for (const seq of oldest) history.delete(seq)
  }
  eventHistory.set(runId, history)
  const ordered = [...history.values()].sort((a, b) => a.seq - b.seq)
  const output = ordered.map(eventText).filter((text): text is string => Boolean(text)).slice(-200)
  const authority = snapshotAuthorities.get(runId)
  const newerStatus = [...ordered].reverse().find(event => (
    event.kind === 'status' && event.status && (!authority || event.seq > authority.seq)
  ))
  const status = newerStatus?.status ?? authority?.status ?? current.status
  setRun(key, { output, status, workers: workerThreads(ordered) })
  if (['needs_review', 'failed', 'cancelled'].includes(status)) {
    subscriptions.get(runId)?.abort()
    subscriptions.delete(runId)
  }
}

function mergeSnapshot(key: string, snapshot: NativeRunSnapshot) {
  const maxSeq = (snapshot.events ?? []).reduce((max, event) => (
    Number.isSafeInteger(event?.seq) ? Math.max(max, event.seq) : max
  ), -1)
  const authority = snapshotAuthorities.get(snapshot.runId)
  // A snapshot's status describes the registry at the same point as its event
  // buffer. Older status events in that buffer must not overwrite `unknown` or
  // a terminal status. A live status with a greater sequence still wins.
  if (!authority || maxSeq >= authority.seq) {
    snapshotAuthorities.set(snapshot.runId, { seq: maxSeq, status: snapshot.status })
  }
  mergeEvents(key, snapshot.runId, snapshot.events ?? [])
}

async function attach(key: string, runId: string) {
  if (subscriptions.has(runId)) return
  const ac = new AbortController()
  subscriptions.set(runId, ac)
  try {
    const unlisten = await safeListen<NativeRunEvent>(`native_run_event:${chanId(runId)}`, event => {
      mergeEvents(key, runId, [event.payload])
    })
    if (ac.signal.aborted) unlisten()
    else ac.signal.addEventListener('abort', unlisten, { once: true })
  } catch (error) {
    subscriptions.delete(runId)
    throw error
  }
}

export async function reconcileNativeRuns(workspaceId: string) {
  const pending = reconciling.get(workspaceId)
  if (pending) return pending
  const task = (async () => {
    const local = [...states.values()].filter(run => run.workspaceId === workspaceId && run.runId)
    const generationsAtStart = new Map(keyGenerations)
    const candidates = new Map(local.map(run => [run.runId!, { key: run.key, runId: run.runId! }]))
    const applySnapshot = (snapshot: NativeRunSnapshot) => {
      const key = `${snapshot.workspaceId}:${snapshot.ticketId}`
      const current = states.get(key)
      const generationChanged = (keyGenerations.get(key) ?? 0) !== (generationsAtStart.get(key) ?? 0)
      // An explicit start owns its new attempt identity. A snapshot requested
      // before that start, or a retained snapshot for an older attempt, cannot
      // replace the new starting/running/unknown attempt at the ticket key.
      const differentRetainedTerminal = Boolean(
        current?.runId && current.runId !== snapshot.runId
        && ['starting', 'running', 'unknown'].includes(current.status)
        && ['needs_review', 'failed', 'cancelled'].includes(snapshot.status),
      )
      if (generationChanged || differentRetainedTerminal) return false
      setRun(key, {
        runId: snapshot.runId, workspaceId: snapshot.workspaceId, ticketId: snapshot.ticketId,
        attemptId: snapshot.attemptId, cwd: snapshot.cwd || current?.cwd || '', provider: snapshot.provider,
      })
      mergeSnapshot(key, snapshot)
      candidates.set(snapshot.runId, { key, runId: snapshot.runId })
      return true
    }
    await Promise.all(local.filter(run => ['starting', 'running', 'unknown'].includes(run.status)).map(async run => {
      try { await attach(run.key, run.runId!) } catch { /* snapshot reconciliation continues and a later pass retries */ }
    }))
    let discovered: NativeRunSnapshot[]
    try {
      discovered = await invoke('native_run_snapshot', { workspaceId })
      if (!Array.isArray(discovered)) discovered = []
    } catch {
      for (const run of local) {
        const current = states.get(run.key)
        const generationChanged = (keyGenerations.get(run.key) ?? 0) !== (generationsAtStart.get(run.key) ?? 0)
        if (!generationChanged && current?.runId === run.runId && ['starting', 'running', 'unknown'].includes(current.status)) {
          setRun(run.key, { status: 'unknown' })
        }
      }
      return
    }
    // Backend-only runs cannot be subscribed before their IDs are known.
    // Subscribe after discovery, then snapshot again; the second buffer closes
    // the discovery/listener gap and sequence de-duplication closes its overlap.
    for (const snapshot of discovered) {
      const key = `${snapshot.workspaceId}:${snapshot.ticketId}`
      if (!applySnapshot(snapshot)) continue
      try { await attach(key, snapshot.runId) } catch { /* second snapshot still gives a truthful point-in-time view */ }
      const current = states.get(key)
      if (current?.runId !== snapshot.runId || ['needs_review', 'failed', 'cancelled'].includes(current.status)) {
        subscriptions.get(snapshot.runId)?.abort()
        subscriptions.delete(snapshot.runId)
      }
    }
    let snapshots: NativeRunSnapshot[]
    try {
      snapshots = await invoke('native_run_snapshot', { workspaceId })
      if (!Array.isArray(snapshots)) snapshots = []
    } catch {
      for (const snapshot of discovered) {
        const key = `${snapshot.workspaceId}:${snapshot.ticketId}`
        if (states.get(key)?.runId === snapshot.runId) mergeSnapshot(key, snapshot)
      }
      return
    }
    const activeIds = new Set(snapshots.map(run => run.runId))
    for (const run of candidates.values()) {
      if (!activeIds.has(run.runId!)) {
        subscriptions.get(run.runId!)?.abort()
        subscriptions.delete(run.runId!)
        const current = states.get(run.key)
        if (current?.runId === run.runId && ['starting', 'running', 'unknown'].includes(current.status)) setRun(run.key, { status: 'unknown' })
      }
    }
    for (const snapshot of snapshots) {
      const key = `${snapshot.workspaceId}:${snapshot.ticketId}`
      if (!applySnapshot(snapshot)) continue
      try { await attach(key, snapshot.runId) } catch { /* a later reconcile retries registration */ }
      const current = states.get(key)
      if (current?.runId !== snapshot.runId || ['needs_review', 'failed', 'cancelled'].includes(current.status)) {
        subscriptions.get(snapshot.runId)?.abort()
        subscriptions.delete(snapshot.runId)
      }
    }
  })().finally(() => reconciling.delete(workspaceId))
  reconciling.set(workspaceId, task)
  return task
}

async function reconcileNativeRunsFresh(workspaceId: string) {
  const inFlight = reconciling.get(workspaceId)
  if (inFlight) await inFlight
  await reconcileNativeRuns(workspaceId)
}

export async function startNativeRun(key: string, args: { runId: string; workspaceId: string; ticketId: string; attemptId: string; provider: NativeProvider; cwd: string; prompt: string }) {
  if (['starting', 'running', 'unknown'].includes(states.get(key)?.status ?? 'idle')) return
  keyGenerations.set(key, (keyGenerations.get(key) ?? 0) + 1)
  setRun(key, { runId: args.runId, workspaceId: args.workspaceId, ticketId: args.ticketId, attemptId: args.attemptId, cwd: args.cwd, provider: args.provider, status: 'starting', output: [], workers: [] })
  eventHistory.set(args.runId, new Map())
  snapshotAuthorities.delete(args.runId)
  let listenerReady = true
  try { await attach(key, args.runId) } catch { listenerReady = false }
  try {
    await invoke('native_run_start', args)
    if (!listenerReady) await reconcileNativeRunsFresh(args.workspaceId)
  } catch (error) {
    subscriptions.get(args.runId)?.abort()
    subscriptions.delete(args.runId)
    // A rejected transport response does not prove whether the backend spawned
    // the child. Reconcile and keep the outcome unknown if it is absent.
    setRun(key, { status: 'unknown', output: [`Start was not confirmed: ${String(error)}`] })
    await reconcileNativeRunsFresh(args.workspaceId)
  }
}

export async function cancelNativeRun(key: string) {
  const run = states.get(key)
  if (!run?.runId) return
  let error: unknown = null
  try { await invoke('native_run_cancel', { runId: run.runId }) }
  catch (cause) { error = cause }

  const current = states.get(key)
  if (current?.runId === run.runId) {
    const patch: Partial<NativeRunState> = {}
    if (['starting', 'running', 'unknown'].includes(current.status)) patch.status = 'unknown'
    if (error) patch.output = [...current.output, `Cancel was not confirmed: ${String(error)}`].slice(-200)
    if (Object.keys(patch).length > 0) setRun(key, patch)
  }

  // The backend retains the exact terminal outcome before the cancel command
  // resolves. Always read it back because event delivery is best-effort. If a
  // reconciliation was already in flight, wait for it and issue a fresh one.
  await reconcileNativeRunsFresh(run.workspaceId)
}

export function useNativeRun(key: string, workspaceId: string, ticketId: string): NativeRunState {
  let empty = emptyStates.get(key)
  if (!empty) {
    empty = { key, runId: null, workspaceId, ticketId, attemptId: null, cwd: '', provider: 'claude', status: 'idle', output: [], workers: [] }
    emptyStates.set(key, empty)
  }
  useEffect(() => { void reconcileNativeRuns(workspaceId) }, [workspaceId])
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener) },
    () => states.get(key) ?? empty!,
    () => states.get(key) ?? empty!,
  )
}

/**
 * Mark a live session's work on a ticket as ready for review. The backend
 * records it as a finished attempt; capture and approval bind to that attempt
 * exactly as they do for a provider run.
 */
export async function submitSessionAttempt(args: { workspaceId: string; ticketId: string; attemptId: string; cwd: string }) {
  const snapshot = await invoke<{ runId: string; attemptId: string }>('native_session_submit', args)
  const identity = { workspaceId: args.workspaceId, ticketId: args.ticketId, runId: snapshot?.runId ?? `${args.workspaceId}:${args.ticketId}:${args.attemptId}`, attemptId: args.attemptId }
  await reconcileNativeRunsFresh(args.workspaceId).catch(() => { /* the request page reconciles again when it opens */ })
  return identity
}
