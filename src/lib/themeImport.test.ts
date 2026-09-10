import { describe, it, expect } from 'vitest'
import { applyPaletteToCSS, contrastRatio, parseGhosttyTheme } from './themeImport'
import { BUNDLED_THEMES } from '../themes'

it('gives every bundled palette readable labels on matching elevated surfaces', () => {
  for (const palette of BUNDLED_THEMES) {
    applyPaletteToCSS(palette)
    const css = document.documentElement.style
    expect(contrastRatio(css.getPropertyValue('--bs-fg-faint'), css.getPropertyValue('--bs-bg-elev'))).toBeGreaterThanOrEqual(4.5)
    expect(css.getPropertyValue('--bs-bg')).toBe(palette.background)
    expect(css.getPropertyValue('--bs-border')).not.toBe('')
  }
})

describe('parseGhosttyTheme', () => {
  it('parses background/foreground/cursor', () => {
    const src = `
background = #282828
foreground = #ebdbb2
cursor-color = #fabd2f
`
    const t = parseGhosttyTheme('test', src)
    expect(t.background).toBe('#282828')
    expect(t.foreground).toBe('#ebdbb2')
    expect(t.cursor).toBe('#fabd2f')
  })

  it('parses 16 ANSI palette slots', () => {
    const lines = Array.from({ length: 16 }, (_, i) => `palette = ${i}=#${String(i).padStart(6, '0')}`)
    const t = parseGhosttyTheme('test', lines.join('\n'))
    expect(t.black).toBe('#000000')        // slot 0
    expect(t.white).toBe('#000007')        // slot 7
    expect(t.brightBlack).toBe('#000008') // slot 8
    expect(t.brightWhite).toBe('#000015') // slot 15 = hex 0f = decimal 15
  })

  it('parses selection colors when present', () => {
    const src = `
selection-background = #585b70
selection-foreground = #cdd6f4
`
    const t = parseGhosttyTheme('test', src)
    expect(t.selectionBackground).toBe('#585b70')
    expect(t.selectionForeground).toBe('#cdd6f4')
  })

  it('ignores full-line comment lines (# prefix)', () => {
    const src = `
# this is a comment
background = #1e1e2e
foreground = #cdd6f4
`
    const t = parseGhosttyTheme('test', src)
    expect(t.background).toBe('#1e1e2e')
    expect(t.foreground).toBe('#cdd6f4')
  })

  it('falls back to tokyonight defaults for missing slots', () => {
    const t = parseGhosttyTheme('empty', '')
    expect(t.background).toBe('#1f2335')
    expect(t.foreground).toBe('#c0caf5')
    expect(t.blue).toBe('#7aa2f7')
  })

  it('sets name from argument', () => {
    const t = parseGhosttyTheme('my-theme', '')
    expect(t.name).toBe('my-theme')
  })
})
