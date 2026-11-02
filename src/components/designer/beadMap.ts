// What the bead map shows, as plain data so it can be tested without a DOM.
//
// bd has three kinds of link and they mean different things:
//   parent-child  grouping: an epic contains tickets. Drawn as a lane, not an arrow.
//   blocks        order: one ticket must finish first. Drawn as an arrow.
//   anything else (relates-to, discovered-from): a note, listed in the inspector.

import type { Dependency, Issue } from '../../types/issue'

export type BeadState = 'ready' | 'in_progress' | 'blocked' | 'closed'

export interface BeadRelations {
  blockedBy: string[]
  blocks: string[]
  parent: string | null
  children: string[]
  related: string[]
}

const NODE_W = 216
const COL_GAP = 64
const ROW_GAP = 14
const PAD = 20
const LANE_HEADER = 40
const LANE_GAP = 18
const TITLE_CHARS_PER_LINE = 26

export const NODE_WIDTH = NODE_W
export const STANDALONE_LANE = 'standalone'

export interface MapNode {
  issue: Issue
  state: BeadState
  next: boolean
  lane: string
  x: number
  y: number
  height: number
}

export interface MapLane {
  id: string
  epic: Issue | null
  title: string
  done: number
  total: number
  y: number
  height: number
}

export interface MapEdge {
  from: string
  to: string
}

export interface BeadMap {
  nodes: MapNode[]
  lanes: MapLane[]
  edges: MapEdge[]
  width: number
  height: number
}

export interface MapFilter {
  query: string
  showDone: boolean
  states: ReadonlySet<BeadState>
}

export function classifyBead(issue: Issue, readyIds: ReadonlySet<string>): BeadState {
  if (issue.status === 'closed') return 'closed'
  if (issue.status === 'in_progress') return 'in_progress'
  if (issue.status === 'blocked') return 'blocked'
  return readyIds.has(issue.id) ? 'ready' : 'blocked'
}

function linkType(dependency: Dependency): string {
  return dependency.type || 'blocks'
}

export function beadRelations(issues: Issue[]): Map<string, BeadRelations> {
  const map = new Map<string, BeadRelations>(issues.map(issue => [issue.id, { blockedBy: [], blocks: [], parent: null, children: [], related: [] }]))
  const setParent = (child: string, parent: string) => {
    const entry = map.get(child)
    const owner = map.get(parent)
    if (!entry || !owner || entry.parent === parent || child === parent) return
    entry.parent = parent
    owner.children.push(child)
  }
  for (const issue of issues) {
    if (issue.parent) setParent(issue.id, issue.parent)
    for (const dependency of issue.dependencies ?? []) {
      if (dependency.issue_id !== issue.id || !map.has(dependency.depends_on_id)) continue
      const type = linkType(dependency)
      if (type === 'parent-child') setParent(issue.id, dependency.depends_on_id)
      else if (type === 'blocks') {
        map.get(issue.id)!.blockedBy.push(dependency.depends_on_id)
        map.get(dependency.depends_on_id)!.blocks.push(issue.id)
      } else {
        map.get(issue.id)!.related.push(dependency.depends_on_id)
        map.get(dependency.depends_on_id)!.related.push(issue.id)
      }
    }
  }
  return map
}

/** The outermost ancestor: its lane is where a nested ticket belongs. */
function rootOf(id: string, relations: Map<string, BeadRelations>): string {
  const seen = new Set([id])
  let current = id
  for (;;) {
    const parent = relations.get(current)?.parent
    if (!parent || seen.has(parent)) return current
    seen.add(parent)
    current = parent
  }
}

/** Every bead reachable by following one direction of the blocker arrows. */
export function chain(start: string, relations: Map<string, BeadRelations>, direction: 'blockedBy' | 'blocks'): Set<string> {
  const reached = new Set<string>()
  const pending = [...(relations.get(start)?.[direction] ?? [])]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (reached.has(id) || id === start) continue
    reached.add(id)
    pending.push(...(relations.get(id)?.[direction] ?? []))
  }
  return reached
}

function titleLines(title: string): number {
  let lines = 1
  let length = 0
  for (const word of title.trim().split(/\s+/).filter(Boolean)) {
    const wrapped = Math.ceil(word.length / TITLE_CHARS_PER_LINE)
    if (wrapped > 1) {
      lines += wrapped - (length === 0 ? 1 : 0)
      length = word.length % TITLE_CHARS_PER_LINE
      continue
    }
    const next = length === 0 ? word.length : length + 1 + word.length
    if (next > TITLE_CHARS_PER_LINE) { lines++; length = word.length } else length = next
  }
  return lines
}

function nodeHeight(title: string): number {
  // Header row, gap, and titles clamped to four lines by the stylesheet.
  return 38 + Math.min(4, titleLines(title)) * 18
}

function matches(issue: Issue, query: string): boolean {
  if (!query) return true
  return issue.id.toLowerCase().includes(query) || issue.title.toLowerCase().includes(query)
}

export function layoutBeadMap(issues: Issue[], readyIds: ReadonlySet<string>, filter: MapFilter): BeadMap {
  const relations = beadRelations(issues)
  const query = filter.query.trim().toLowerCase()
  const byId = new Map(issues.map(issue => [issue.id, issue]))

  // An epic is its lane's header, so it only appears as a card with no children.
  const isLaneHeader = (issue: Issue) => (relations.get(issue.id)?.children.length ?? 0) > 0 && !relations.get(issue.id)?.parent
  const visible = issues.filter(issue => {
    if (isLaneHeader(issue)) return false
    const state = classifyBead(issue, readyIds)
    if (state === 'closed' && !filter.showDone) return false
    if (filter.states.size > 0 && !filter.states.has(state)) return false
    return matches(issue, query)
  })
  const visibleIds = new Set(visible.map(issue => issue.id))

  const columns = new Map<string, number>()
  const columnOf = (id: string, path: Set<string>): number => {
    const known = columns.get(id)
    if (known !== undefined) return known
    let column = 0
    for (const blocker of relations.get(id)?.blockedBy ?? []) {
      if (!visibleIds.has(blocker) || path.has(blocker)) continue
      path.add(blocker)
      column = Math.max(column, columnOf(blocker, path) + 1)
      path.delete(blocker)
    }
    columns.set(id, column)
    return column
  }

  const grouped = new Map<string, Issue[]>()
  for (const issue of visible) {
    const root = rootOf(issue.id, relations)
    const lane = root !== issue.id && byId.has(root) ? root : STANDALONE_LANE
    const group = grouped.get(lane)
    if (group) group.push(issue)
    else grouped.set(lane, [issue])
  }

  const stateRank: Record<BeadState, number> = { in_progress: 0, ready: 1, blocked: 2, closed: 3 }
  const laneOrder = [...grouped.keys()].sort((a, b) => {
    if (a === STANDALONE_LANE) return 1
    if (b === STANDALONE_LANE) return -1
    const epicA = byId.get(a)!
    const epicB = byId.get(b)!
    return epicA.priority - epicB.priority || a.localeCompare(b)
  })

  const nodes: MapNode[] = []
  const lanes: MapLane[] = []
  let cursor = PAD
  let widest = 0
  for (const laneId of laneOrder) {
    const members = grouped.get(laneId)!
    const inColumn = new Map<number, Issue[]>()
    for (const issue of members) {
      const column = columnOf(issue.id, new Set([issue.id]))
      const list = inColumn.get(column)
      if (list) list.push(issue)
      else inColumn.set(column, [issue])
    }
    let tallest = 0
    for (const [column, list] of inColumn) {
      list.sort((a, b) => stateRank[classifyBead(a, readyIds)] - stateRank[classifyBead(b, readyIds)] || a.priority - b.priority)
      let y = 0
      for (const issue of list) {
        const height = nodeHeight(issue.title)
        nodes.push({
          issue,
          state: classifyBead(issue, readyIds),
          next: false,
          lane: laneId,
          x: PAD + 12 + column * (NODE_W + COL_GAP),
          y: cursor + LANE_HEADER + y,
          height,
        })
        y += height + ROW_GAP
      }
      tallest = Math.max(tallest, y - ROW_GAP)
      widest = Math.max(widest, column)
    }
    const epic = laneId === STANDALONE_LANE ? null : byId.get(laneId)!
    const family = epic ? issues.filter(issue => rootOf(issue.id, relations) === epic.id && issue.id !== epic.id) : members
    const height = LANE_HEADER + tallest + 16
    lanes.push({
      id: laneId,
      epic,
      title: epic?.title ?? 'Not part of an epic',
      done: family.filter(issue => issue.status === 'closed').length,
      total: family.length,
      y: cursor,
      height,
    })
    cursor += height + LANE_GAP
  }

  const firstReady = [...nodes].sort((a, b) => a.issue.priority - b.issue.priority).find(node => node.state === 'ready')
  if (firstReady) firstReady.next = true

  const placed = new Set(nodes.map(node => node.issue.id))
  const edges = nodes.flatMap(node => (relations.get(node.issue.id)?.blockedBy ?? [])
    .filter(blocker => placed.has(blocker))
    .map(blocker => ({ from: blocker, to: node.issue.id })))

  return {
    nodes,
    lanes,
    edges,
    width: PAD * 2 + 24 + (widest + 1) * NODE_W + widest * COL_GAP,
    height: Math.max(cursor, PAD),
  }
}

export function beadCounts(issues: Issue[], readyIds: ReadonlySet<string>): Record<BeadState, number> {
  const counts: Record<BeadState, number> = { ready: 0, in_progress: 0, blocked: 0, closed: 0 }
  for (const issue of issues) counts[classifyBead(issue, readyIds)]++
  return counts
}
