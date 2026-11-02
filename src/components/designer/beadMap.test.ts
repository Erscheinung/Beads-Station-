import { describe, expect, it } from 'vitest'
import type { Dependency, Issue } from '../../types/issue'
import { beadCounts, beadRelations, chain, layoutBeadMap, STANDALONE_LANE, type BeadState } from './beadMap'

function issue(id: string, overrides: Partial<Issue> = {}, dependencies: [string, string][] = []): Issue {
  return {
    id, title: id, description: null, status: 'open', priority: 2, issue_type: 'task', assignee: null,
    created_at: '', updated_at: '', closed_at: null, dependency_count: 0, dependent_count: 0, comment_count: 0,
    labels: null, parent: null,
    dependencies: dependencies.map(([dependsOn, type]): Dependency => ({ issue_id: id, depends_on_id: dependsOn, type })),
    ...overrides,
  }
}

const noFilter = { query: '', showDone: false, states: new Set<BeadState>() }

describe('bead relations', () => {
  it('keeps containment, order and notes apart', () => {
    const relations = beadRelations([
      issue('epic'),
      issue('a', {}, [['epic', 'parent-child']]),
      issue('b', {}, [['epic', 'parent-child'], ['a', 'blocks'], ['c', 'relates-to']]),
      issue('c'),
    ])
    expect(relations.get('epic')!.children).toEqual(['a', 'b'])
    expect(relations.get('b')!).toMatchObject({ parent: 'epic', blockedBy: ['a'], related: ['c'] })
    expect(relations.get('a')!.blocks).toEqual(['b'])
    expect(relations.get('epic')!.blocks).toEqual([])
  })

  it('treats an untyped dependency as a blocker, and survives a cycle', () => {
    const relations = beadRelations([
      issue('a', {}, [['b', '']]),
      issue('b', {}, [['a', 'blocks']]),
    ])
    expect(relations.get('a')!.blockedBy).toEqual(['b'])
    expect(chain('a', relations, 'blockedBy')).toEqual(new Set(['b']))
  })
})

describe('bead map layout', () => {
  const ready = new Set(['a', 'loose'])
  const issues = [
    issue('epic', { issue_type: 'epic' }),
    issue('a', {}, [['epic', 'parent-child']]),
    issue('b', {}, [['epic', 'parent-child'], ['a', 'blocks']]),
    issue('gone', { status: 'closed' }, [['epic', 'parent-child']]),
    issue('loose'),
  ]

  it('groups an epic into a lane with its progress and draws only blockers', () => {
    const map = layoutBeadMap(issues, ready, noFilter)
    expect(map.lanes.map(lane => lane.id)).toEqual(['epic', STANDALONE_LANE])
    expect(map.lanes[0]).toMatchObject({ done: 1, total: 3 })
    expect(map.nodes.map(node => node.issue.id).sort()).toEqual(['a', 'b', 'loose'])
    expect(map.edges).toEqual([{ from: 'a', to: 'b' }])
    const [a, b] = ['a', 'b'].map(id => map.nodes.find(node => node.issue.id === id)!)
    expect(b.x).toBeGreaterThan(a.x)
    expect(map.nodes.filter(node => node.next)).toHaveLength(1)
  })

  it('never overlaps two cards in the same column', () => {
    const many = [issue('e'), ...Array.from({ length: 6 }, (_, index) => issue(`t${index}`, { title: 'a long title '.repeat(index) }, [['e', 'parent-child']]))]
    const nodes = layoutBeadMap(many, new Set(), noFilter).nodes.sort((a, b) => a.y - b.y)
    for (let index = 1; index < nodes.length; index++) expect(nodes[index].y).toBeGreaterThanOrEqual(nodes[index - 1].y + nodes[index - 1].height)
  })

  it('filters by done, state and search', () => {
    expect(layoutBeadMap(issues, ready, { ...noFilter, showDone: true }).nodes).toHaveLength(4)
    expect(layoutBeadMap(issues, ready, { ...noFilter, states: new Set<BeadState>(['blocked']) }).nodes.map(n => n.issue.id)).toEqual(['b'])
    expect(layoutBeadMap(issues, ready, { ...noFilter, query: 'LOOSE' }).nodes.map(n => n.issue.id)).toEqual(['loose'])
  })

  it('counts every bead once', () => {
    expect(beadCounts(issues, ready)).toEqual({ ready: 2, in_progress: 0, blocked: 2, closed: 1 })
  })
})
