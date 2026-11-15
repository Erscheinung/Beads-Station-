// Pure grouping, filtering and limiting for the Requests board (RequestBoard.tsx).
// The board keeps four columns but only draws a bounded slice of each: cards are
// sorted by priority then recency, children of one epic fold into a single group
// card, and a "Focus" lens hides what does not need attention yet. Nothing here
// touches React, so it stays cheap for hundreds of tickets and is unit tested.

import type { Issue } from '../../types/issue'
import type { BeadRelations, BeadState } from './beadMap'
import { classifyBead } from './beadMap'
import type { SessionNode } from './activity'
import { isLive } from './activity'

export type Lens = 'focus' | 'all'
export type Density = 'comfortable' | 'compact'

export interface BoardFilters {
  lens: Lens
  query: string
  /** Selected priorities; empty means any. 3 stands for P3 and below. */
  priorities: ReadonlySet<number>
  liveOnly: boolean
}

/** Cards shown per column before "Show more". Done is a history, so it starts shorter. */
export const INITIAL_LIMIT: Record<BeadState, number> = { ready: 8, in_progress: 10, blocked: 8, closed: 5 }
export const LIMIT_STEP = 10
/** A finished request stays in the Focus lens this long. */
export const FOCUS_DONE_MS = 3 * 24 * 60 * 60 * 1000

export interface EpicProgress { done: number; total: number }

export type BoardEntry =
  | { kind: 'card'; issue: Issue }
  | { kind: 'group'; epicId: string; title: string; children: Issue[]; progress: EpicProgress }

export interface ColumnView {
  state: BeadState
  /** Tickets matching the lens and filters, children inside groups included. */
  total: number
  /** Matching tickets the lens hid (only Focus hides anything). */
  hiddenByLens: number
  /** Top-level entries (cards and groups) before slicing. */
  entryCount: number
  entries: BoardEntry[]
  remaining: number
}

export function byPriorityThenRecent(a: Issue, b: Issue): number {
  return a.priority - b.priority || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)
}

export function byClosedRecently(a: Issue, b: Issue): number {
  return (b.closed_at ?? b.updated_at).localeCompare(a.closed_at ?? a.updated_at) || a.id.localeCompare(b.id)
}

/** Ids of tickets an agent session is writing on right now. */
export function liveBeadIds(tree: SessionNode[]): Set<string> {
  const ids = new Set<string>()
  for (const node of tree) if (isLive(node)) for (const id of node.beads) ids.add(id)
  return ids
}

/** Does Focus keep this ticket? Waiting always; moving work with a live session or urgent; urgent ready; recent done. */
export function needsAttention(issue: Issue, state: BeadState, live: ReadonlySet<string>, now: number): boolean {
  switch (state) {
    case 'blocked': return true
    case 'in_progress': return live.has(issue.id) || issue.priority <= 1
    case 'ready': return issue.priority <= 1
    case 'closed': {
      const at = Date.parse(issue.closed_at ?? issue.updated_at)
      return Number.isFinite(at) && now - at <= FOCUS_DONE_MS
    }
  }
}

export function epicProgress(epicId: string, relations: ReadonlyMap<string, BeadRelations>, byId: ReadonlyMap<string, Issue>): EpicProgress {
  const ids = relations.get(epicId)?.children ?? []
  let done = 0
  for (const id of ids) if (byId.get(id)?.status === 'closed') done++
  return { done, total: ids.length }
}

export interface BuildInput {
  issues: Issue[]
  readyIds: ReadonlySet<string>
  relations: ReadonlyMap<string, BeadRelations>
  live: ReadonlySet<string>
  filters: BoardFilters
  limits: Partial<Record<BeadState, number>>
  now?: number
}

const STATES: BeadState[] = ['ready', 'in_progress', 'blocked', 'closed']

export function buildBoard({ issues, readyIds, relations, live, filters, limits, now = Date.now() }: BuildInput): Map<BeadState, ColumnView> {
  const needle = filters.query.trim().toLowerCase()
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const buckets = new Map<BeadState, Issue[]>(STATES.map(state => [state, []]))
  const hidden = new Map<BeadState, number>(STATES.map(state => [state, 0]))

  for (const issue of issues) {
    // An epic with tickets under it is a heading (group card), not a request.
    if ((relations.get(issue.id)?.children.length ?? 0) > 0) continue
    if (needle && !issue.title.toLowerCase().includes(needle) && !issue.id.toLowerCase().includes(needle)) continue
    if (filters.priorities.size > 0 && !filters.priorities.has(Math.min(issue.priority, 3))) continue
    if (filters.liveOnly && !live.has(issue.id)) continue
    const state = classifyBead(issue, readyIds)
    if (filters.lens === 'focus' && !needsAttention(issue, state, live, now)) { hidden.set(state, hidden.get(state)! + 1); continue }
    buckets.get(state)!.push(issue)
  }

  const result = new Map<BeadState, ColumnView>()
  for (const state of STATES) {
    const sorted = buckets.get(state)!.sort(state === 'closed' ? byClosedRecently : byPriorityThenRecent)
    // Fold siblings of one epic into one group; a lone child stays a plain card.
    const perEpic = new Map<string, Issue[]>()
    for (const issue of sorted) {
      const parent = relations.get(issue.id)?.parent
      if (parent && byId.has(parent)) perEpic.set(parent, [...(perEpic.get(parent) ?? []), issue])
    }
    const entries: BoardEntry[] = []
    const emitted = new Set<string>()
    for (const issue of sorted) {
      const parent = relations.get(issue.id)?.parent
      const siblings = parent ? perEpic.get(parent) : undefined
      if (parent && siblings && siblings.length > 1) {
        // The group sits where its best child would, so order stays by priority then recency.
        if (emitted.has(parent)) continue
        emitted.add(parent)
        entries.push({ kind: 'group', epicId: parent, title: byId.get(parent)!.title, children: siblings, progress: epicProgress(parent, relations, byId) })
      } else entries.push({ kind: 'card', issue })
    }
    const limit = limits[state] ?? INITIAL_LIMIT[state]
    result.set(state, {
      state,
      total: sorted.length,
      hiddenByLens: hidden.get(state)!,
      entryCount: entries.length,
      entries: entries.slice(0, limit),
      remaining: Math.max(0, entries.length - limit),
    })
  }
  return result
}

/** Matching tickets the Focus lens is hiding, across all columns. */
export function hiddenTotal(view: Map<BeadState, ColumnView>): number {
  let sum = 0
  for (const column of view.values()) sum += column.hiddenByLens
  return sum
}
