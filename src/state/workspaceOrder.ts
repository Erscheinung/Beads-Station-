import { useEffect, useSyncExternalStore } from 'react'
import { persistDurableUserConfigKey } from '../lib/durableUserConfig'

const KEY = 'beads-station.workspace-order.v1'

interface WorkspaceOrderState {
  ids: string[]
}

function load(): WorkspaceOrderState {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return { ids: Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === 'string'))] : [] }
  } catch {
    return { ids: [] }
  }
}

let state = load()
const listeners = new Set<() => void>()

function persist(): void {
  try { localStorage.setItem(KEY, JSON.stringify(state.ids)) } catch { /* optional storage */ }
  persistDurableUserConfigKey(KEY)
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

function normalized(ids: string[]): string[] {
  const available = new Set(ids)
  const kept = state.ids.filter(id => available.has(id))
  const seen = new Set(kept)
  return [...kept, ...ids.filter(id => !seen.has(id))]
}

/** Return the persisted order projected onto the currently open workspaces. */
export function workspaceOrder(ids: string[]): string[] {
  return normalized(ids)
}

/** Add newly opened workspaces at the end while preserving explicit order. */
export function reconcileWorkspaceOrder(ids: string[]): void {
  const next = normalized(ids)
  if (same(next, state.ids)) return
  state = { ids: next }
  persist()
  listeners.forEach(listener => listener())
}

export function reorderWorkspace(fromId: string, toId: string): void {
  if (fromId === toId) return
  const ids = state.ids.slice()
  const from = ids.indexOf(fromId)
  const to = ids.indexOf(toId)
  if (from < 0 || to < 0) return
  ids.splice(from, 1)
  ids.splice(to, 0, fromId)
  state = { ids }
  persist()
  listeners.forEach(listener => listener())
  window.dispatchEvent(new CustomEvent('workspace:reordered', { detail: { fromId, toId, order: ids } }))
}

export function moveWorkspace(id: string, delta: -1 | 1): void {
  const index = state.ids.indexOf(id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= state.ids.length) return
  reorderWorkspace(id, state.ids[target])
}

export function subscribeWorkspaceOrder(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot(): WorkspaceOrderState {
  return state
}

/** React view of the persistent order. Reconciliation is effect-based so the
 * store never mutates during render. */
export function useWorkspaceOrder(ids: string[]): string[] {
  const signature = ids.join('\u0000')
  const snap = useSyncExternalStore(subscribeWorkspaceOrder, snapshot, snapshot)
  useEffect(() => { reconcileWorkspaceOrder(ids) }, [signature])
  return snap.ids
}

export function __resetWorkspaceOrderForTest(): void {
  state = { ids: [] }
  try { localStorage.removeItem(KEY) } catch { /* optional */ }
  persistDurableUserConfigKey(KEY)
  listeners.forEach(listener => listener())
}
