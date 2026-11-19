import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ openSplitInFolder: vi.fn(), setSkin: vi.fn(), toast: vi.fn() }))
vi.mock('../state/termPanes', () => ({ openSplitInFolder: mocks.openSplitInFolder }))
vi.mock('../state/skin', () => ({ setSkin: mocks.setSkin }))
vi.mock('./invokeErrorBoundary', () => ({ pushNoticeToast: mocks.toast }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { canFork, forkSession } from './forkSession'

const ID = '2c975569-13c1-43b2-8e7a-f88d6138d7d8'

describe('forkSession', () => {
  beforeEach(() => vi.clearAllMocks())

  it('opens a split in the folder running the fork command, and says it forked the whole session', () => {
    expect(forkSession({ cwd: '~/proj', provider: 'claude', sessionId: ID })).toBe(true)
    expect(mocks.openSplitInFolder).toHaveBeenCalledWith('~/proj', `claude --resume ${ID} --fork-session`)
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('can’t fork at a single message'))
    expect(mocks.setSkin).not.toHaveBeenCalled()
  })
  it('uses codex fork for Codex and can switch to the terminal', () => {
    expect(forkSession({ cwd: '~/proj', provider: 'codex', sessionId: ID, showTerminal: true })).toBe(true)
    expect(mocks.openSplitInFolder.mock.calls[0][1]).toContain(`codex fork ${ID}`)
    expect(mocks.setSkin).toHaveBeenCalledWith('terminal')
  })
  it('does nothing for a provider without fork or a bad id', () => {
    expect(canFork('qwen')).toBe(false)
    expect(forkSession({ cwd: '~/p', provider: 'qwen', sessionId: ID })).toBe(false)
    expect(forkSession({ cwd: '~/p', provider: 'claude', sessionId: 'x; rm' })).toBe(false)
    expect(mocks.openSplitInFolder).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })
})
