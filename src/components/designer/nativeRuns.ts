import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { safeListen } from '../../lib/safeListen'
import { chanId } from '../../lib/eventChannel'

export type NativeProvider = 'claude' | 'codex'
export type NativeRunStatus = 'idle' | 'starting' | 'running' | 'needs_review' | 'failed' | 'cancelled' | 'unknown'
export interface NativeRunState { key: string; runId: string | null; provider: NativeProvider; status: NativeRunStatus; output: string[] }

const STORAGE = 'beads-station.designer-runs.v1'
const listeners = new Set<() => void>()
let states = new Map<string, NativeRunState>()
const emptyStates = new Map<string, NativeRunState>()

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE) ?? '[]') as NativeRunState[]
  states = new Map(saved.map(run => [run.key, {
    ...run,
    status: run.status === 'running' || run.status === 'starting' ? 'unknown' : run.status,
  }]))
} catch { /* corrupt summaries do not block requests */ }

function emit() {
  try { localStorage.setItem(STORAGE, JSON.stringify([...states.values()].slice(-50))) } catch { /* current session still works */ }
  listeners.forEach(listener => listener())
}
function setRun(key: string, patch: Partial<NativeRunState>) {
  const current = states.get(key) ?? { key, runId: null, provider: 'claude', status: 'idle', output: [] }
  states = new Map(states).set(key, { ...current, ...patch })
  emit()
}
function eventText(event: any): string | null {
  if (event?.kind === 'stderr') return String(event.line ?? '')
  const value = event?.parsed
  if (typeof value?.message === 'string') return value.message
  if (typeof value?.text === 'string') return value.text
  const blocks = value?.message?.content
  if (Array.isArray(blocks)) {
    const text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
    if (text) return text
  }
  if (value?.item?.type === 'agent_message' && typeof value.item.text === 'string') return value.item.text
  return null
}

export async function startNativeRun(key: string, args: { runId: string; provider: NativeProvider; cwd: string; prompt: string }) {
  if (['starting', 'running', 'unknown'].includes(states.get(key)?.status ?? 'idle')) return
  setRun(key, { runId: args.runId, provider: args.provider, status: 'starting', output: [] })
  const ac = new AbortController()
  try {
    await safeListen<any>(`native_run_event:${chanId(args.runId)}`, event => {
      const payload = event.payload
      const current = states.get(key)
      if (!current || current.runId !== args.runId) return
      const text = eventText(payload)
      const output = text ? [...current.output, text].slice(-200) : current.output
      const status = payload?.kind === 'status' ? payload.status as NativeRunStatus : current.status
      setRun(key, { output, status })
      if (['needs_review', 'failed', 'cancelled'].includes(status)) ac.abort()
    }, ac.signal)
    await invoke('native_run_start', args)
  } catch (error) {
    ac.abort()
    setRun(key, { status: 'failed', output: [`Could not start ${args.provider}: ${String(error)}`] })
  }
}

export async function cancelNativeRun(key: string) {
  const run = states.get(key)
  if (!run?.runId) return
  try { await invoke('native_run_cancel', { runId: run.runId }) }
  catch (error) { setRun(key, { output: [...run.output, `Cancel was not confirmed: ${String(error)}`].slice(-200) }) }
}

export function useNativeRun(key: string): NativeRunState {
  let empty = emptyStates.get(key)
  if (!empty) {
    empty = { key, runId: null, provider: 'claude', status: 'idle', output: [] }
    emptyStates.set(key, empty)
  }
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener) },
    () => states.get(key) ?? empty!,
    () => states.get(key) ?? empty!,
  )
}
