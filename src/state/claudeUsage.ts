// Phase 6 — per-project Claude usage accumulator.
//
// A tiny external store, same shape as src/state/vim.ts, that keeps a running
// total of Claude CLI token + cost usage per projectId. Components subscribe
// via useUsage(projectId) which is backed by useSyncExternalStore.
//
// Accumulation rule (locked in the P6 brief):
//   - frame.type === 'result'                                  -> always count
//   - frame.type === 'assistant'
//       && frame.parent_tool_use_id == null
//       && frame.message?.usage                                -> count
//   - everything else (system, hook, partial, tool sub-agent) -> ignored
//
// We never re-emit on a no-op (a frame that yields zero deltas), so listeners
// only run when the meter actually changes.

import { useSyncExternalStore } from 'react'

export interface Usage {
  cost: number
  in: number
  out: number
  cacheRead: number
  cacheCreate: number
}

const ZERO: Usage = { cost: 0, in: 0, out: 0, cacheRead: 0, cacheCreate: 0 }

const usageByProject = new Map<string, Usage>()
const listenersByProject = new Map<string, Set<() => void>>()

function emit(projectId: string): void {
  const set = listenersByProject.get(projectId)
  if (!set) return
  set.forEach(l => l())
}

export function getUsage(projectId: string): Usage {
  return usageByProject.get(projectId) ?? ZERO
}

export function subscribeUsage(projectId: string, listener: () => void): () => void {
  let set = listenersByProject.get(projectId)
  if (!set) {
    set = new Set()
    listenersByProject.set(projectId, set)
  }
  set.add(listener)
  return () => {
    const s = listenersByProject.get(projectId)
    if (!s) return
    s.delete(listener)
    if (s.size === 0) listenersByProject.delete(projectId)
  }
}

// Pull a numeric usage field defensively. Claude's stream-json returns these
// as integers; treat undefined / null / non-finite as 0.
function num(x: unknown): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 0
  return x
}

export function accumulate(projectId: string, frame: unknown): void {
  if (!frame || typeof frame !== 'object') return
  const f = frame as Record<string, unknown>

  let usage: Record<string, unknown> | null = null
  let costDelta = 0

  if (f.type === 'result') {
    // Result frames carry total_cost_usd at the top level and a `usage` object.
    const u = f.usage
    if (u && typeof u === 'object') usage = u as Record<string, unknown>
    costDelta = num(f.total_cost_usd)
  } else if (
    f.type === 'assistant' &&
    f.parent_tool_use_id == null &&
    f.message &&
    typeof f.message === 'object'
  ) {
    const m = f.message as Record<string, unknown>
    const u = m.usage
    if (u && typeof u === 'object') usage = u as Record<string, unknown>
    // Assistant frames don't carry total_cost_usd; cost only ticks on result.
  } else {
    return
  }

  const inDelta = usage ? num(usage.input_tokens) : 0
  const outDelta = usage ? num(usage.output_tokens) : 0
  const cacheReadDelta = usage ? num(usage.cache_read_input_tokens) : 0
  const cacheCreateDelta = usage ? num(usage.cache_creation_input_tokens) : 0

  if (
    costDelta === 0 &&
    inDelta === 0 &&
    outDelta === 0 &&
    cacheReadDelta === 0 &&
    cacheCreateDelta === 0
  ) {
    return
  }

  const prev = usageByProject.get(projectId) ?? ZERO
  const next: Usage = {
    cost: prev.cost + costDelta,
    in: prev.in + inDelta,
    out: prev.out + outDelta,
    cacheRead: prev.cacheRead + cacheReadDelta,
    cacheCreate: prev.cacheCreate + cacheCreateDelta,
  }
  usageByProject.set(projectId, next)
  emit(projectId)
}

export function useUsage(projectId: string): Usage {
  return useSyncExternalStore(
    listener => subscribeUsage(projectId, listener),
    () => getUsage(projectId),
    () => getUsage(projectId),
  )
}

// Reset is exposed for tests / debugging. Not used by the UI.
export function resetUsage(projectId: string): void {
  if (!usageByProject.has(projectId)) return
  usageByProject.delete(projectId)
  emit(projectId)
}
