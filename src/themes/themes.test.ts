import { describe, it, expect } from 'vitest'
import { BUNDLED_THEMES } from './index'
import { contrastRatio, deriveChrome, paletteAppearance, parseGhosttyTheme } from '../lib/themeImport'
import { resolveCmdColor, DEFAULT_TERMINAL_APPEARANCE } from '../state/terminalAppearance'

const HEX = /^#[0-9a-f]{6}$/i
const byId = (id: string) => BUNDLED_THEMES.find(t => t.name === id)!

describe('bundled themes', () => {
  it('ships the expected set with unique ids', () => {
    const ids = BUNDLED_THEMES.map(t => t.name)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['fahrenheit', 'tokyonight-storm', 'catppuccin-mocha', 'gruvbox-dark', 'rose-pine', 'one-light', 'dracula', 'nord', 'kanagawa-wave', 'everforest-dark', 'solarized-light', 'github-dark', 'github-light', 'monokai-pro']) expect(ids).toContain(id)
  })

  it.each(BUNDLED_THEMES.map(t => [t.name, t] as const))('%s parses to complete hex colours', (_id, t) => {
    for (const [key, value] of Object.entries(t)) {
      if (key === 'name' || value === undefined) continue
      expect(value, key).toMatch(HEX)
    }
  })

  it.each(BUNDLED_THEMES.map(t => [t.name, t] as const))('%s keeps chrome text readable (4.5:1)', (_id, t) => {
    const c = deriveChrome(t)
    for (const surface of [c.bg, c.bgElev]) {
      expect(contrastRatio(c.fg, surface), 'fg').toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(c.fgMuted, surface), 'muted').toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(c.accent, surface), 'accent').toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(BUNDLED_THEMES.map(t => [t.name, t] as const))('%s terminal text, white and cursor are visible', (_id, t) => {
    expect(contrastRatio(t.foreground, t.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(t.white, t.background), 'white').toBeGreaterThanOrEqual(3)
    expect(contrastRatio(t.brightWhite, t.background), 'brightWhite').toBeGreaterThanOrEqual(3)
    expect(contrastRatio(t.cursor, t.background), 'cursor').toBeGreaterThanOrEqual(1.5)
    expect(contrastRatio(t.cursorAccent, t.cursor), 'cursor text').toBeGreaterThanOrEqual(1.5)
  })

  it('decides light or dark from the background luminance', () => {
    const light = BUNDLED_THEMES.filter(t => paletteAppearance(t) === 'light').map(t => t.name).sort()
    expect(light).toEqual(['github-light', 'one-light', 'solarized-light'])
    expect(paletteAppearance({ background: '#101010' })).toBe('dark')
    expect(paletteAppearance({ background: '#f0f0f0' })).toBe('light')
  })

  it('keeps Fahrenheit looking as it did', () => {
    const f = byId('fahrenheit')
    expect(f.accent).toBe('#d2ab8b')
    expect(f.orange).toBe('#fecf75')
    const c = deriveChrome(f)
    expect(c.fg).toBe('#ffffce')
    expect(c.accent).toBe('#d2ab8b')
    expect(c.orange).toBe('#fecf75')
  })

  it('falls back to ANSI blue and yellow when a source has no extra keys', () => {
    const p = parseGhosttyTheme('x', 'background = #000000\nforeground = #ffffff\npalette = 4=#5599ff\npalette = 3=#ddaa33\n')
    expect(p.accent).toBe('#5599ff')
    expect(p.orange).toBe('#ddaa33')
    expect(p.cmdColor).toBe('#5599ff')
    expect(p.cursorAccent).toBe('#000000')
  })
})

describe('typed command colour', () => {
  it('defaults to orange for Fahrenheit and the accent elsewhere', () => {
    expect(resolveCmdColor(DEFAULT_TERMINAL_APPEARANCE, byId('fahrenheit').cmdColor)).toBe('#fd9f4d')
    for (const t of BUNDLED_THEMES.filter(t => t.name !== 'fahrenheit')) expect(t.cmdColor).toBe(t.accent)
    expect(resolveCmdColor(DEFAULT_TERMINAL_APPEARANCE, byId('nord').cmdColor)).toBe('#88c0d0')
  })

  it('honours custom and off, and rejects anything that is not #rrggbb', () => {
    const base = DEFAULT_TERMINAL_APPEARANCE
    expect(resolveCmdColor({ ...base, cmdColorMode: 'custom', cmdColorCustom: '#112233' }, '#abcdef')).toBe('#112233')
    expect(resolveCmdColor({ ...base, cmdColorMode: 'off' }, '#abcdef')).toBeNull()
    expect(resolveCmdColor({ ...base, cmdColorMode: 'theme' }, 'red; rm -rf')).toBeNull()
  })
})
