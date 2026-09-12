import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))

import {
  getInteractiveChatProvider,
  getNativeProviderAvailability,
  providerAvailability,
  providerLabel,
  refreshNativeProviderAvailability,
  setInteractiveChatProvider,
} from './chatProviders'

describe('interactive chat providers', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    setInteractiveChatProvider('claude')
  })

  it('persists only the supported provider choice', () => {
    setInteractiveChatProvider('codex')
    expect(getInteractiveChatProvider()).toBe('codex')
    expect(localStorage.getItem('beads-station.interactive-chat-provider')).toBe('codex')

    setInteractiveChatProvider('unsupported' as never)
    expect(getInteractiveChatProvider()).toBe('codex')
  })

  it('normalizes capability status to the supported provider set', async () => {
    mockInvoke.mockResolvedValue([
      { provider: 'codex', available: true, executable: '/mock/codex', detail: 'ready' },
      { provider: 'third-party', available: true, executable: '/mock/other', detail: 'ignored' },
    ])

    await refreshNativeProviderAvailability()

    const statuses = getNativeProviderAvailability()
    expect(statuses).toEqual([
      { provider: 'claude', available: false, executable: null, detail: 'Unavailable' },
      { provider: 'codex', available: true, executable: '/mock/codex', detail: 'ready' },
    ])
    expect(providerAvailability(statuses, 'codex')).toMatchObject({ available: true })
    expect(providerLabel('claude')).toBe('Claude')
    expect(providerLabel('codex')).toBe('Codex')
  })
})
