import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  store: {
    get: vi.fn(async (key: string) => mocks.data[key]),
    set: vi.fn(async (key: string, value: unknown) => { mocks.data[key] = value }),
    save: vi.fn(async () => {}),
  },
}))

vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: vi.fn(async () => mocks.store) } }))

import { __resetDurableUserConfigForTest, hydrateDurableUserConfig, persistDurableUserConfigKey } from './durableUserConfig'

describe('durable user configuration', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.data = {}
    mocks.store.get.mockClear()
    mocks.store.set.mockClear()
    mocks.store.save.mockClear()
    __resetDurableUserConfigForTest()
  })

  it('migrates allowlisted browser preferences without copying runtime or provider data', async () => {
    localStorage.setItem('beads-station.command-bindings.v1', JSON.stringify({ palette: 'Mod+K' }))
    localStorage.setItem('bs.claude.session:bridge', 'provider-session-id')
    localStorage.setItem('beads-station.termPanes', '{"output":"bounded screen"}')

    await hydrateDurableUserConfig()

    const saved = mocks.data.config as { schemaVersion: number; values: Record<string, string> }
    expect(saved.schemaVersion).toBe(1)
    expect(saved.values['beads-station.command-bindings.v1']).toContain('Mod+K')
    expect(saved.values['bs.claude.session:bridge']).toBeUndefined()
    expect(saved.values['beads-station.termPanes']).toBeUndefined()
  })

  it('hydrates installed browser storage from native values and keeps later changes durable', async () => {
    mocks.data.config = { schemaVersion: 1, values: { 'beads-station.skin': 'designer' } }
    await hydrateDurableUserConfig()
    expect(localStorage.getItem('beads-station.skin')).toBe('designer')

    localStorage.setItem('beads-station.skin', 'terminal')
    persistDurableUserConfigKey('beads-station.skin')
    await new Promise(resolve => setTimeout(resolve, 0))
    const saved = mocks.data.config as { values: Record<string, string> }
    expect(saved.values['beads-station.skin']).toBe('terminal')
  })
})
