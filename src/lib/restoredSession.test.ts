import { describe, expect, it } from 'vitest'
import { recoverSession } from './restoredSession'

const at = 1_800_000_000_000
const list = [
  { id: 'a', provider: 'claude', modifiedMs: at - 60_000 },
  { id: 'b', provider: 'claude', modifiedMs: at - 3_600_000 },
  { id: 'c', provider: 'codex', modifiedMs: at - 1_000 },
  { id: 'd', provider: 'claude', modifiedMs: at + 86_400_000 },
]

describe('recoverSession', () => {
  it('picks the newest session of the same CLI written before the screen was saved', () => {
    expect(recoverSession(list, 'claude', at)?.id).toBe('a')
    expect(recoverSession(list, 'codex', at)?.id).toBe('c')
  })
  it('skips sessions another pane already claims', () => {
    expect(recoverSession(list, 'claude', at, new Set(['a']))?.id).toBe('b')
  })
  it('ignores a session written long after the pane stopped', () => {
    expect(recoverSession([list[3]], 'claude', at)).toBeNull()
  })
  it('takes the newest when the capture time is unknown, and nothing across providers', () => {
    expect(recoverSession(list, 'claude', null)?.id).toBe('d')
    expect(recoverSession(list, 'gemini', at)).toBeNull()
  })
})
