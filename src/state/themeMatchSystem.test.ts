import { describe, it, expect, beforeEach, vi } from 'vitest'

// A controllable prefers-color-scheme: the store reads matches and listens for change.
function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<() => void>()
  const media = { matches: initialDark }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      get matches() { return media.matches },
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    }),
  })
  return (dark: boolean) => { media.matches = dark; listeners.forEach(l => l()) }
}

async function load() {
  vi.resetModules()
  const theme = await import('./theme')
  const skin = await import('./skin')
  skin.setSkin('terminal')
  return theme
}

describe('match system appearance', () => {
  beforeEach(() => { localStorage.clear() })

  it('is off by default and leaves the chosen theme alone', async () => {
    installMatchMedia(false)
    const t = await load()
    expect(t.getMatchSystem().enabled).toBe(false)
    expect(t.getThemePaletteId()).toBe('tokyonight-storm')
  })

  it('follows the system live between the chosen light and dark themes', async () => {
    const setSystemDark = installMatchMedia(true)
    const t = await load()
    t.setMatchSystem({ enabled: true, light: 'github-light', dark: 'nord' })
    expect(t.getThemePaletteId()).toBe('nord')
    expect(t.getTheme()).toBe('dark')
    setSystemDark(false)
    expect(t.getThemePaletteId()).toBe('github-light')
    expect(t.getTheme()).toBe('light')
    setSystemDark(true)
    expect(t.getThemePaletteId()).toBe('nord')
  })

  it('only accepts a light theme for light mode and a dark one for dark mode', async () => {
    installMatchMedia(true)
    const t = await load()
    t.setMatchSystem({ light: 'nord', dark: 'one-light' })
    expect(t.getMatchSystem()).toMatchObject({ light: 'one-light', dark: 'tokyonight-storm' })
  })

  it('persists and restores the setting', async () => {
    installMatchMedia(false)
    const first = await load()
    first.setMatchSystem({ enabled: true, light: 'solarized-light', dark: 'dracula' })
    expect(JSON.parse(localStorage.getItem('beads-station.match-system-theme.v1')!)).toEqual({ enabled: true, light: 'solarized-light', dark: 'dracula' })
    const second = await load()
    expect(second.getMatchSystem()).toEqual({ enabled: true, light: 'solarized-light', dark: 'dracula' })
    expect(second.getThemePaletteId()).toBe('solarized-light')
  })

  it('is part of the durable user config', async () => {
    const { isDurableUserConfigKey } = await import('../lib/durableUserConfig')
    expect(isDurableUserConfigKey('beads-station.match-system-theme.v1')).toBe(true)
  })
})
