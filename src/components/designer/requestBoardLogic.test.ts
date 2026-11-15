import { describe, expect, it } from 'vitest'
import type { Issue } from '../../types/issue'
import { beadRelations } from './beadMap'
import { buildBoard, hiddenTotal, INITIAL_LIMIT, liveBeadIds, needsAttention, type BoardFilters } from './requestBoardLogic'

const NOW = Date.parse('2026-11-16T12:00:00Z')
function issue(id: string, over: Partial<Issue> = {}): Issue {
  return { id, title: `Title ${id}`, description: null, status: 'open', priority: 2, issue_type: 'task', assignee: null,
    created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-10T00:00:00Z', closed_at: null,
    dependency_count: 0, dependent_count: 0, comment_count: 0, labels: null, parent: null, dependencies: [], ...over }
}
const child = (id: string, parent: string, over: Partial<Issue> = {}) =>
  issue(id, { parent, dependencies: [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }], ...over })
const all: BoardFilters = { lens: 'all', query: '', priorities: new Set(), liveOnly: false }
function run(issues: Issue[], filters: Partial<BoardFilters> = {}, live: string[] = [], limits = {}) {
  const readyIds = new Set(issues.filter(i => i.status === 'open').map(i => i.id))
  return buildBoard({ issues, readyIds, relations: beadRelations(issues), live: new Set(live), filters: { ...all, ...filters }, limits, now: NOW })
}

describe('request board logic', () => {
  it('sorts by priority then most recently updated', () => {
    const view = run([issue('a', { priority: 2, updated_at: '2026-11-01T00:00:00Z' }), issue('b', { priority: 2, updated_at: '2026-11-12T00:00:00Z' }), issue('c', { priority: 0 })])
    expect(view.get('ready')!.entries.map(e => e.kind === 'card' && e.issue.id)).toEqual(['c', 'b', 'a'])
  })

  it('bounds each column and reports what remains', () => {
    const many = Array.from({ length: 22 }, (_, i) => issue(`t${i}`))
    const ready = run(many).get('ready')!
    expect(ready.total).toBe(22)
    expect(ready.entries).toHaveLength(INITIAL_LIMIT.ready)
    expect(ready.remaining).toBe(22 - INITIAL_LIMIT.ready)
    expect(run(many, {}, [], { ready: 30 }).get('ready')!.remaining).toBe(0)
  })

  it('folds siblings under their epic with progress, leaves a lone child as a card', () => {
    const issues = [issue('e', { issue_type: 'epic' }), child('e.1', 'e'), child('e.2', 'e'), child('e.3', 'e', { status: 'closed', closed_at: '2026-11-15T00:00:00Z' })]
    const view = run(issues)
    const ready = view.get('ready')!
    expect(ready.entries).toHaveLength(1)
    const group = ready.entries[0]
    expect(group.kind === 'group' && group.children.map(c => c.id)).toEqual(['e.1', 'e.2'])
    expect(group.kind === 'group' && group.progress).toEqual({ done: 1, total: 3 })
    expect(ready.total).toBe(2)
    const done = view.get('closed')!
    expect(done.entries[0].kind).toBe('card')
  })

  it('search and priority and live filters narrow the set', () => {
    const issues = [issue('a', { title: 'Footer' }), issue('b', { priority: 0 }), issue('c', { priority: 4 })]
    expect(run(issues, { query: 'foot' }).get('ready')!.total).toBe(1)
    expect(run(issues, { priorities: new Set([0]) }).get('ready')!.total).toBe(1)
    expect(run(issues, { priorities: new Set([3]) }).get('ready')!.total).toBe(1)
    expect(run(issues, { liveOnly: true }, ['c']).get('ready')!.total).toBe(1)
  })

  it('focus keeps waiting, live or urgent progress, urgent ready, recent done and counts the rest', () => {
    const issues = [
      issue('r1', { priority: 1 }), issue('r2', { priority: 2 }),
      issue('p1', { status: 'in_progress' }), issue('p2', { status: 'in_progress' }),
      issue('w', { status: 'blocked' }),
      issue('d1', { status: 'closed', closed_at: '2026-11-15T00:00:00Z' }), issue('d2', { status: 'closed', closed_at: '2026-10-01T00:00:00Z' }),
    ]
    const view = run(issues, { lens: 'focus' }, ['p1'])
    expect(view.get('ready')!.entries).toHaveLength(1)
    expect(view.get('in_progress')!.entries.map(e => e.kind === 'card' && e.issue.id)).toEqual(['p1'])
    expect(view.get('blocked')!.total).toBe(1)
    expect(view.get('closed')!.total).toBe(1)
    expect(hiddenTotal(view)).toBe(3)
    expect(needsAttention(issue('x', { priority: 3 }), 'ready', new Set(), NOW)).toBe(false)
  })

  it('collects live ticket ids from running sessions only', () => {
    const node = (status: 'running' | 'idle', beads: string[]) => ({ summary: {} as never, status, duration: null, beads, children: [] })
    expect([...liveBeadIds([node('running', ['a']), node('idle', ['b'])])]).toEqual(['a'])
  })
})
