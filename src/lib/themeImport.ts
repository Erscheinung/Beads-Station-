// Parse ghostty theme files into a ThemePalette.
//
// Ghostty format (subset we care about):
//   background = #hex
//   foreground = #hex
//   cursor-color = #hex
//   selection-background = #hex
//   selection-foreground = #hex
//   palette = 0=#hex  (0-15, ANSI colors)
//   cursor-text = #hex  (text under a block cursor; defaults to the background)
//
// Beads Station extras (ignored by Ghostty, which skips unknown keys):
//   bs-accent = #hex     interface accent; defaults to ANSI blue, lifted if it is hard to read
//   bs-orange = #hex     warm highlight; defaults to ANSI yellow
//   bs-cmd-color = #hex  default colour of typed shell commands; defaults to the accent
//
// The 16 ANSI slots: 0-7 normal, 8-15 bright.

export interface ThemePalette {
  name: string
  background: string
  foreground: string
  cursor: string
  selectionBackground?: string
  selectionForeground?: string
  /** Text colour under a block cursor. */
  cursorAccent: string
  /** Interface accent (links, selection, focus). Explicit so it never depends on which ANSI slot is blue. */
  accent: string
  /** Warm highlight used for "needs attention" chrome. */
  orange: string
  /** Default colour for typed shell commands ("Typed command colour: Theme default"). */
  cmdColor: string
  // ANSI 0-15
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  cyan: string
  magenta: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightCyan: string
  brightMagenta: string
  brightWhite: string
}

function parseGhosttyColor(val: string): string {
  const v = val.trim()
  if (v.startsWith('#')) return v
  // ghostty also allows rgb:rr/gg/bb — ignore for now, return as-is
  return v
}

/** Parse a ghostty-format theme file into a ThemePalette. */
export function parseGhosttyTheme(name: string, source: string): ThemePalette {
  const ansi: Record<number, string> = {}
  let background = '#1f2335'
  let foreground = '#c0caf5'
  let cursor = '#c0caf5'
  let selectionBackground: string | undefined
  let selectionForeground: string | undefined
  let cursorAccent: string | undefined
  let accent: string | undefined
  let orange: string | undefined
  let cmdColor: string | undefined

  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()

    if (key === 'background') background = parseGhosttyColor(val)
    else if (key === 'foreground') foreground = parseGhosttyColor(val)
    else if (key === 'cursor-color') cursor = parseGhosttyColor(val)
    else if (key === 'selection-background') selectionBackground = parseGhosttyColor(val)
    else if (key === 'selection-foreground') selectionForeground = parseGhosttyColor(val)
    else if (key === 'cursor-text') cursorAccent = parseGhosttyColor(val)
    else if (key === 'bs-accent') accent = parseGhosttyColor(val)
    else if (key === 'bs-orange') orange = parseGhosttyColor(val)
    else if (key === 'bs-cmd-color') cmdColor = parseGhosttyColor(val)
    else if (key === 'palette') {
      const sep = val.indexOf('=')
      if (sep !== -1) {
        const idx = parseInt(val.slice(0, sep), 10)
        const color = parseGhosttyColor(val.slice(sep + 1))
        if (!isNaN(idx) && idx >= 0 && idx <= 15) ansi[idx] = color
      }
    }
  }

  const slot = (i: number, fallback: string) => ansi[i] ?? fallback
  const blue = slot(4, '#7aa2f7')
  const yellow = slot(3, '#e0af68')
  const resolvedAccent = accent ?? ensureContrast(blue, [background], 4.5)

  return {
    name,
    background,
    foreground,
    cursor,
    selectionBackground,
    selectionForeground,
    cursorAccent: cursorAccent ?? background,
    accent: resolvedAccent,
    orange: orange ?? yellow,
    cmdColor: cmdColor ?? resolvedAccent,
    black:         slot(0, '#414868'),
    red:           slot(1, '#f7768e'),
    green:         slot(2, '#9ece6a'),
    yellow,
    blue,
    magenta:       slot(5, '#bb9af7'),
    cyan:          slot(6, '#7dcfff'),
    white:         slot(7, '#a9b1d6'),
    brightBlack:   slot(8, '#414868'),
    brightRed:     slot(9, '#f7768e'),
    brightGreen:   slot(10, '#9ece6a'),
    brightYellow:  slot(11, '#e0af68'),
    brightBlue:    slot(12, '#7aa2f7'),
    brightMagenta: slot(13, '#bb9af7'),
    brightCyan:    slot(14, '#7dcfff'),
    brightWhite:   slot(15, '#c0caf5'),
  }
}

/** Apply a ThemePalette to the document's CSS custom properties. */
export function mixColor(background: string, foreground: string, amount: number): string {
  const b = background.replace('#', ''), f = foreground.replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(b) || !/^[0-9a-f]{6}$/i.test(f)) return foreground
  return '#' + [0, 2, 4].map(i => Math.round(parseInt(b.slice(i, i + 2), 16) * (1 - amount) + parseInt(f.slice(i, i + 2), 16) * amount).toString(16).padStart(2, '0')).join('')
}
export function relativeLuminance(c: string): number {
  const rgb = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
}
export function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a), y = relativeLuminance(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}
/** Light or dark, from the background's luminance rather than a theme id. */
export function paletteAppearance(p: Pick<ThemePalette, 'background'>): 'light' | 'dark' {
  return contrastRatio(p.background, '#000000') > contrastRatio(p.background, '#ffffff') ? 'light' : 'dark'
}
/**
 * Move `color` away from the backgrounds (toward white on dark ones, black on
 * light ones) until it reaches `min` contrast on every one of them. A colour
 * that already passes is returned untouched.
 */
export function ensureContrast(color: string, backgrounds: string[], min: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color
  const worst = (c: string) => Math.min(...backgrounds.map(bg => contrastRatio(c, bg)))
  if (worst(color) >= min) return color
  const target = backgrounds.every(bg => paletteAppearance({ background: bg }) === 'light') ? '#000000' : '#ffffff'
  for (let step = 1; step <= 20; step++) {
    const candidate = mixColor(color, target, step / 20)
    if (worst(candidate) >= min) return candidate
  }
  return target
}
export interface ChromeColors {
  bg: string; fg: string; bgElev: string; bgFloat: string; border: string; borderFaint: string
  fgMuted: string; fgFaint: string; accent: string; orange: string
}
/** Interface colours derived from a palette; every text colour reaches 4.5:1 on the surfaces it sits on. */
export function deriveChrome(p: ThemePalette): ChromeColors {
  const bgElev = mixColor(p.background, p.foreground, .055)
  const bgFloat = mixColor(p.background, p.foreground, .035)
  const surfaces = [p.background, bgElev]
  const fg = ensureContrast(p.foreground, surfaces, 4.5)
  return {
    bg: p.background,
    fg,
    bgElev,
    bgFloat,
    border: mixColor(p.background, p.foreground, .18),
    borderFaint: mixColor(p.background, p.foreground, .09),
    fgMuted: ensureContrast(mixColor(p.background, fg, .78), surfaces, 4.5),
    fgFaint: ensureContrast(mixColor(p.background, fg, .62), surfaces, 4.5),
    accent: ensureContrast(p.accent, surfaces, 4.5),
    orange: ensureContrast(p.orange, surfaces, 3),
  }
}
export function applyPaletteToCSS(p: ThemePalette): void {
  const r = document.documentElement.style
  const c = deriveChrome(p)
  r.setProperty('--bs-bg',       c.bg)
  r.setProperty('--bs-bg-dark',  c.bg)
  r.setProperty('--bs-fg',       c.fg)
  r.setProperty('--bs-bg-elev',  c.bgElev)
  r.setProperty('--bs-bg-float', c.bgFloat)
  r.setProperty('--bs-border',   c.border)
  r.setProperty('--bs-border-faint', c.borderFaint)
  r.setProperty('--bs-fg-muted', c.fgMuted)
  r.setProperty('--bs-fg-faint', c.fgFaint)
  r.setProperty('--bs-red',      p.red)
  r.setProperty('--bs-green',    p.green)
  r.setProperty('--bs-yellow',   p.yellow)
  r.setProperty('--bs-cyan',     p.cyan)
  r.setProperty('--bs-magenta',  p.magenta)
  r.setProperty('--bs-purple',   p.magenta)
  r.setProperty('--bs-blue',     c.accent)
  r.setProperty('--bs-accent',   c.accent)
  r.setProperty('color-scheme', paletteAppearance(p))
  r.setProperty('--bs-orange',   c.orange)
}

/** Reset CSS custom properties to stylesheet defaults (empty string). */
export function resetPaletteCSS(): void {
  const r = document.documentElement.style
  for (const prop of [
    '--bs-bg', '--bs-bg-dark', '--bs-fg', '--bs-fg-muted', '--bs-fg-faint',
    '--bs-red', '--bs-green', '--bs-yellow', '--bs-cyan',
    '--bs-magenta', '--bs-purple', '--bs-blue', '--bs-accent', '--bs-orange',
    '--bs-bg-elev', '--bs-bg-float', '--bs-border', '--bs-border-faint', 'color-scheme',
  ]) {
    r.removeProperty(prop)
  }
}
