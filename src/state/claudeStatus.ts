// Phase 6 — per-project Claude session status atom.
//
// Mirrors src/state/vim.ts's useSyncExternalStore pattern but keyed by
// projectId. We expose useClaudeStatus(projectId) returning one of:
//   "running"        — assistant frame in flight or just received
//   "awaiting-input" — idle since the last user send (or explicitly awaiting permission)
//   "error"          — any stderr or claude_start failure since last clear
//   "idle"           — fresh, never started
//
// Backend (Worker 1) emits canonical events on `claude_status:{projectId}`.
// As a defensive fallback we ALSO derive state from `claude_event:{projectId}`
// + `claude_stderr:{projectId}` so the FE keeps working even if the BE-side
// status emit is incomplete or arrives out of order.
//
// Subscriptions are started lazily on first `useClaudeStatus` per projectId
// so we don't leak listeners for projects that are never observed.

import { useSyncExternalStore } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type ClaudeStatus = 'running' | 'awaiting-input' | 'error' | 'idle'

const VALID = new Set<ClaudeStatus>(['running', 'awaiting-input', 'error', 'idle'])

interface ProjectEntry {
  status: ClaudeStatus
  refCount: number
  unlisten: UnlistenFn[]
  startedAt: number
}

const entries = new Map<string, ProjectEntry>()
const listenersByProject = new Map<string, Set<() => void>>()

function emit(projectId: string): void {
  const set = listenersByProject.get(projectId)
  if (!set) return
  set.forEach(l => l())
}

function setStatus(projectId: string, next: ClaudeStatus): void {
  const e = entries.get(projectId)
  if (!e) return
  if (e.status === next) return
  e.status = next
  emit(projectId)
}

function deriveFromFrame(frame: unknown): ClaudeStatus | null {
  if (!frame || typeof frame !== 'object') return null
  const f = frame as Record<string, unknown>
  if (f.type === 'assistant') return 'running'
  if (f.type === 'result') return 'awaiting-input'
  // system/init, hook, partial — leave the running state alone.
  return null
}

async function startSubscription(projectId: string): Promise<void> {
  const e = entries.get(projectId)
  if (!e) return
  // claude_status — canonical, BE-emitted (Worker 1).
  try {
    const off = await listen<string>(`claude_status:${projectId}`, ev => {
      const v = String(ev.payload)
      if (VALID.has(v as ClaudeStatus)) setStatus(projectId, v as ClaudeStatus)
    })
    e.unlisten.push(off)
  } catch (err) {
    console.warn('[claudeStatus] failed to attach claude_status listener', err)
  }
  // claude_event — frame stream; defensive fallback.
  try {
    const off = await listen(`claude_event:${projectId}`, ev => {
      const next = deriveFromFrame(ev.payload)
      if (next) setStatus(projectId, next)
    })
    e.unlisten.push(off)
  } catch (err) {
    console.warn('[claudeStatus] failed to attach claude_event listener', err)
  }
  // claude_stderr — any stderr line drives state to error.
  try {
    const off = await listen(`claude_stderr:${projectId}`, () => {
      setStatus(projectId, 'error')
    })
    e.unlisten.push(off)
  } catch (err) {
    console.warn('[claudeStatus] failed to attach claude_stderr listener', err)
  }
}

function ensureEntry(projectId: string): ProjectEntry {
  let e = entries.get(projectId)
  if (!e) {
    e = { status: 'idle', refCount: 0, unlisten: [], startedAt: Date.now() }
    entries.set(projectId, e)
    void startSubscription(projectId)
  }
  return e
}

export function getClaudeStatus(projectId: string): ClaudeStatus {
  return entries.get(projectId)?.status ?? 'idle'
}

export function subscribeClaudeStatus(projectId: string, listener: () => void): () => void {
  const e = ensureEntry(projectId)
  e.refCount += 1
  let set = listenersByProject.get(projectId)
  if (!set) {
    set = new Set()
    listenersByProject.set(projectId, set)
  }
  set.add(listener)
  return () => {
    const s = listenersByProject.get(projectId)
    if (s) {
      s.delete(listener)
      if (s.size === 0) listenersByProject.delete(projectId)
    }
    const ent = entries.get(projectId)
    if (ent) {
      ent.refCount -= 1
      if (ent.refCount <= 0) {
        ent.unlisten.forEach(u => {
          try { u() } catch { /* noop */ }
        })
        entries.delete(projectId)
      }
    }
  }
}

export function useClaudeStatus(projectId: string): ClaudeStatus {
  return useSyncExternalStore(
    listener => subscribeClaudeStatus(projectId, listener),
    () => getClaudeStatus(projectId),
    () => getClaudeStatus(projectId),
  )
}
