import { beforeEach, describe, expect, it, vi } from 'vitest'

const { bdInitialize, bdSnapshot } = vi.hoisted(() => ({ bdInitialize: vi.fn(), bdSnapshot: vi.fn() }))
vi.mock('../types/issue', () => ({ bdInitialize, bdSnapshot }))

import {
  __resetBeadsInitForTest,
  beadsInitErrorMessage,
  classifyBeadsInitError,
  initializeBeads,
} from './beadsInit'

const report = {
  outcome: 'initialized' as const,
  target: '/tmp/fresh-workspace',
  command: 'bd init --non-interactive',
  message: 'verified',
}

describe('intent-only Beads initialization', () => {
  beforeEach(() => {
    __resetBeadsInitForTest()
    bdInitialize.mockReset()
    bdInitialize.mockResolvedValue(report)
    bdSnapshot.mockReset()
    bdSnapshot.mockResolvedValue({ ready: [], all: [], no_db: false })
  })

  it('coalesces duplicate clicks and refreshes after verified success', async () => {
    const first = initializeBeads('/tmp/fresh-workspace')
    const second = initializeBeads('/tmp/fresh-workspace')
    expect(second).toBe(first)
    await expect(first).resolves.toEqual(report)
    expect(bdInitialize).toHaveBeenCalledTimes(1)
  })

  it('does not coalesce separate canonical workspace targets', async () => {
    await Promise.all([initializeBeads('/tmp/a'), initializeBeads('/tmp/b')])
    expect(bdInitialize).toHaveBeenCalledTimes(2)
  })

  it('distinguishes missing CLI, permissions, corruption and generic failure', () => {
    expect(classifyBeadsInitError('missing_bd: bd not found')).toBe('missing_bd')
    expect(classifyBeadsInitError('permission: read-only file system')).toBe('permission')
    expect(classifyBeadsInitError('corrupt: malformed JSONL')).toBe('corrupt')
    expect(classifyBeadsInitError('failure: command exited 1')).toBe('failure')
    expect(beadsInitErrorMessage('missing_bd: bd not found')).toContain('not installed')
    expect(beadsInitErrorMessage('corrupt: malformed JSONL')).toContain('No reinitialization')
  })
})
