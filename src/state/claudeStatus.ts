// Phase 6 — per-project Claude session status atom.
//
// Mirrors src/state/vim.ts's useSyncExternalStore pattern but keyed by
// projectId. We expose useClaudeStatus(projectId) returning one of:
//   "running"        — assistant frame in flight or just received
//   "awaiting-input" — idle since the last user send (or explicitly awaiting permission)
//   "error"          — any stderr or claude_start failure since last clear
//   "idle"           — fresh, never started
//
// Backend (Worker 1) emits canonical events on `claude_status:{projectId}`:
// "running" (assistant frame), "awaiting-input" (result frame), "error"
// (stderr line), "exited" (child EOF). See src-tauri/src/claude.rs. We drive
// the status dot from that channel alone, plus `claude_stderr:{projectId}` as
// the error signal.
//
// Code-1cs (F4): we used to ALSO listen `claude_event:{projectId}` (the full
// frame stream — the hottest channel) and re-derive status from each frame as
// a defensive fallback. That duplicated ClaudeChat's own claude_event listener
// on every frame. Since claude.rs emits the canonical running/awaiting-input
// transitions itself, the fallback was fully redundant; dropped.
//
// Subscriptions are started lazily on first `useClaudeStatus` per projectId
// so we don't leak listeners for projects that are never observed.

import { useSyncExternalStore } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { chanId } from '../lib/eventChannel'

export type ClaudeStatus = 'running' | 'awaiting-input' | 'error' | 'idle'

const VALID = new Set<ClaudeStatus>(['running', 'awaiting-input', 'error', 'idle'])

interface ProjectEntry {
  status: ClaudeStatus
  refCount: number
  unlisten: UnlistenFn[]
  startedAt: number
  terminated: boolean
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

async function startSubscription(projectId: string): Promise<void> {
  const e = entries.get(projectId)
  if (!e) return
  // claude_status — canonical, BE-emitted (Worker 1).
  try {
    const off = await listen<string>(`claude_status:${chanId(projectId)}`, ev => {
      const v = String(ev.payload)
      if (VALID.has(v as ClaudeStatus)) setStatus(projectId, v as ClaudeStatus)
    })
    if (e.terminated) { off(); return }
    e.unlisten.push(off)
  } catch (err) {
    console.warn('[claudeStatus] failed to attach claude_status listener', err)
  }
  // claude_stderr — any stderr line drives state to error.
  try {
    const off = await listen(`claude_stderr:${chanId(projectId)}`, () => {
      setStatus(projectId, 'error')
    })
    if (e.terminated) { off(); return }
    e.unlisten.push(off)
  } catch (err) {
    console.warn('[claudeStatus] failed to attach claude_stderr listener', err)
  }
}

function ensureEntry(projectId: string): ProjectEntry {
  let e = entries.get(projectId)
  if (!e) {
    e = { status: 'idle', refCount: 0, unlisten: [], startedAt: Date.now(), terminated: false }
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
        ent.terminated = true
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
