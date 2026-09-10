import { describe, expect, it } from 'vitest'
import { restoreSelection, type Project } from './projects'

const projects: Project[] = [
  { id: '/one/app', name: 'app', path: '/one/app', hasGit: true, hasBeads: false, claudeSessionId: '' },
  { id: '/two/app', name: 'app', path: '/two/app', hasGit: true, hasBeads: false, claudeSessionId: '' },
  { id: '/one/unique', name: 'unique', path: '/one/unique', hasGit: true, hasBeads: true, claudeSessionId: '' },
]
describe('workspace restoration', () => {
  it('does not open discovered projects on a fresh launch', () => {
    expect(restoreSelection(projects, null, null)).toEqual({ openIds: [], activeId: null })
  })
  it('migrates only the uniquely identifiable active legacy workspace', () => {
    expect(restoreSelection(projects, null, 'unique')).toEqual({ openIds: ['/one/unique'], activeId: '/one/unique' })
    expect(restoreSelection(projects, null, 'app')).toEqual({ openIds: [], activeId: null })
  })
  it('restores explicit order and drops missing or duplicate IDs', () => {
    expect(restoreSelection(projects, JSON.stringify({ openIds: ['/two/app', '/missing', '/one/app', '/two/app'], activeId: '/missing' }), null)).toEqual({ openIds: ['/two/app', '/one/app'], activeId: '/two/app' })
  })
  it('respects an explicitly empty workspace list and ignores corrupt data', () => {
    expect(restoreSelection(projects, '{"openIds":[]}', 'unique').openIds).toEqual([])
    expect(restoreSelection(projects, 'broken', 'unique').openIds).toEqual([])
  })
})
