import { describe, expect, it } from 'vitest'
import { buildActivity, buildSessionTree, durationLabel, isLive, sessionStatus } from './activity'
import type { TranscriptSummary } from './transcripts'
import type { Issue } from '../../types/issue'

const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime()
const summary = (over: Partial<TranscriptSummary>): TranscriptSummary => ({
  id: 's1', provider: 'claude', title: 't', firstPrompt: '', modifiedMs: NOW, bytes: 1, ...over,
})

describe('sessionStatus', () => {
  it('is running while the file is being written, idle for a while, then finished', () => {
    expect(sessionStatus(summary({ modifiedMs: NOW - 10_000 }), NOW)).toBe('running')
    expect(sessionStatus(summary({ modifiedMs: NOW - 5 * 60_000 }), NOW)).toBe('idle')
    expect(sessionStatus(summary({ modifiedMs: NOW - 3_600_000 }), NOW)).toBe('finished')
  })
  it('trusts a subagent finished marker', () => {
    expect(sessionStatus(summary({ parentId: 'p', finished: true, modifiedMs: NOW - 1000 }), NOW)).toBe('finished')
  })
})

describe('durationLabel', () => {
  it('formats seconds, minutes and hours, and hides an unknown start', () => {
    expect(durationLabel({ createdMs: NOW - 20_000, modifiedMs: NOW })).toBe('20s')
    expect(durationLabel({ createdMs: NOW - 4 * 60_000, modifiedMs: NOW })).toBe('4m')
    expect(durationLabel({ createdMs: NOW - 65 * 60_000, modifiedMs: NOW })).toBe('1h 05m')
    expect(durationLabel({ createdMs: 0, modifiedMs: NOW })).toBeNull()
  })
})

describe('buildSessionTree', () => {
  const list = [
    summary({ id: 'a', firstPrompt: 'Work on Code-12: header', modifiedMs: NOW - 5000 }),
    summary({ id: 'agent-2', parentId: 'a', createdMs: NOW - 2000, modifiedMs: NOW - 1000, title: 'second' }),
    summary({ id: 'agent-1', parentId: 'a', createdMs: NOW - 9000, modifiedMs: NOW - 8000, finished: true, title: 'first' }),
    summary({ id: 'b', provider: 'codex', firstPrompt: 'Code-1.2 only', modifiedMs: NOW - 7_200_000 }),
    summary({ id: 'lost', parentId: 'gone', modifiedMs: NOW }),
  ]
  it('nests subagents oldest first under their session and drops orphans', () => {
    const tree = buildSessionTree(list, ['Code-12', 'Code-1'], NOW)
    expect(tree.map(n => n.summary.id)).toEqual(['a', 'b'])
    expect(tree[0].children.map(c => c.summary.id)).toEqual(['agent-1', 'agent-2'])
    expect(isLive(tree[0])).toBe(true)
    expect(isLive(tree[1])).toBe(false)
  })
  it('links tickets by whole id only, children inherit them', () => {
    const tree = buildSessionTree(list, ['Code-12', 'Code-1'], NOW)
    expect(tree[0].beads).toEqual(['Code-12'])
    expect(tree[0].children[0].beads).toEqual(['Code-12'])
    expect(tree[1].beads).toEqual([])
  })
})

describe('buildActivity', () => {
  const closed = (id: string, at: Date): Issue => ({ id, title: id, status: 'closed', closed_at: at.toISOString() } as unknown as Issue)
  it('groups beads and sessions by local day, newest first', () => {
    const tree = buildSessionTree([summary({ id: 'a', modifiedMs: NOW }), summary({ id: 'old', modifiedMs: NOW - 2 * 86_400_000 })], [], NOW)
    const days = buildActivity([closed('Code-1', new Date(NOW - 3_600_000)), { id: 'Code-2', status: 'open' } as unknown as Issue], tree, 'en-US')
    expect(days).toHaveLength(2)
    expect(days[0].entries.map(e => e.kind)).toEqual(['session', 'bead'])
    expect(days[1].entries).toHaveLength(1)
  })
})
