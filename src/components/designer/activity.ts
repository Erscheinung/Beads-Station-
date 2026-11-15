// Designer Desk: one activity model for the Agents and Timeline views.
// Pure helpers that turn the session summaries (transcripts.rs: Claude, Codex,
// and later Qwen) plus closed tickets into what the views draw. No I/O here.

import type { Issue } from '../../types/issue'
import { mentionsBead, type TranscriptSummary } from './transcripts'

/** Modified this recently means the agent is writing to its session file now. */
export const RUNNING_WINDOW_MS = 60_000
/** Quiet for longer than that but under this: likely waiting on the person (or thinking long). */
export const IDLE_WINDOW_MS = 15 * 60_000

export type SessionStatus = 'running' | 'idle' | 'finished'

/**
 * Honest status from the file alone. A session file does not record its end, so
 * "finished" for a top-level session means "quiet for a while"; a subagent has
 * its own marker and that wins. "idle" is not proof the agent is waiting; exact
 * waiting signals come from the pane hooks, not from here.
 */
export function sessionStatus(summary: Pick<TranscriptSummary, 'modifiedMs' | 'finished' | 'parentId'>, now = Date.now()): SessionStatus {
  if (summary.parentId && summary.finished === true) return 'finished'
  const age = now - summary.modifiedMs
  if (age <= RUNNING_WINDOW_MS) return 'running'
  if (summary.parentId && summary.finished === false) return age <= IDLE_WINDOW_MS ? 'idle' : 'finished'
  return age <= IDLE_WINDOW_MS ? 'idle' : 'finished'
}

/** "12s", "4m", "1h 05m"; null when the start is unknown. */
export function durationLabel(summary: Pick<TranscriptSummary, 'createdMs' | 'modifiedMs'>): string | null {
  const start = summary.createdMs ?? 0
  if (!start || summary.modifiedMs < start) return null
  const seconds = Math.round((summary.modifiedMs - start) / 1000)
  if (seconds < 60) return `${Math.max(1, seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export interface SessionNode {
  summary: TranscriptSummary
  status: SessionStatus
  duration: string | null
  /** Tickets whose id the opening prompt names. */
  beads: string[]
  children: SessionNode[]
}

/** Top-level sessions newest first, each with its subagents (oldest first, so they read as a sequence). */
export function buildSessionTree(summaries: TranscriptSummary[], beadIds: string[], now = Date.now()): SessionNode[] {
  const node = (summary: TranscriptSummary): SessionNode => ({
    summary,
    status: sessionStatus(summary, now),
    duration: durationLabel(summary),
    beads: beadIds.filter(id => mentionsBead(summary, id)),
    children: [],
  })
  const roots = new Map<string, SessionNode>()
  const orphans: TranscriptSummary[] = []
  for (const summary of summaries) {
    if (!summary.parentId) roots.set(`${summary.provider}:${summary.id}`, node(summary))
    else orphans.push(summary)
  }
  for (const summary of orphans.sort((a, b) => (a.createdMs || a.modifiedMs) - (b.createdMs || b.modifiedMs))) {
    const parent = roots.get(`${summary.provider}:${summary.parentId}`)
    if (!parent) continue
    const child = node(summary)
    child.beads = parent.beads
    parent.children.push(child)
  }
  return [...roots.values()].sort((a, b) => b.summary.modifiedMs - a.summary.modifiedMs)
}

/** A session is live when it or any of its subagents is writing now. */
export function isLive(node: SessionNode): boolean {
  return node.status === 'running' || node.children.some(child => child.status === 'running')
}

// ---------- timeline ----------

export type ActivityEntry =
  | { kind: 'bead'; key: string; at: number; issue: Issue }
  | { kind: 'session'; key: string; at: number; node: SessionNode }

export interface ActivityDay { key: string; label: string; entries: ActivityEntry[] }

export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Closed tickets and agent sessions on one axis, grouped by local day, newest
 * first. A session sits at its last activity so a running one is always on top.
 */
export function buildActivity(issues: Issue[], sessions: SessionNode[], locale?: string): ActivityDay[] {
  const entries: ActivityEntry[] = []
  for (const issue of issues) {
    if (issue.status !== 'closed' || !issue.closed_at) continue
    const at = new Date(issue.closed_at).getTime()
    if (Number.isFinite(at)) entries.push({ kind: 'bead', key: `bead:${issue.id}`, at, issue })
  }
  for (const node of sessions) {
    entries.push({ kind: 'session', key: `session:${node.summary.provider}:${node.summary.id}`, at: node.summary.modifiedMs, node })
  }
  entries.sort((a, b) => b.at - a.at)
  const days = new Map<string, ActivityDay>()
  for (const entry of entries) {
    const key = dayKey(entry.at)
    let day = days.get(key)
    if (!day) {
      day = { key, label: new Date(entry.at).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' }), entries: [] }
      days.set(key, day)
    }
    day.entries.push(entry)
  }
  return [...days.values()]
}
