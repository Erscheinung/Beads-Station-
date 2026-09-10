// Parse ghostty theme files into a ThemePalette.
//
// Ghostty format (subset we care about):
//   background = #hex
//   foreground = #hex
//   cursor-color = #hex
//   selection-background = #hex
//   selection-foreground = #hex
//   palette = 0=#hex  (0-15, ANSI colors)
//
// The 16 ANSI slots: 0-7 normal, 8-15 bright.

export interface ThemePalette {
  name: string
  background: string
  foreground: string
  cursor: string
  selectionBackground?: string
  selectionForeground?: string
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

  return {
    name,
    background,
    foreground,
    cursor,
    selectionBackground,
    selectionForeground,
    black:         slot(0, '#414868'),
    red:           slot(1, '#f7768e'),
    green:         slot(2, '#9ece6a'),
    yellow:        slot(3, '#e0af68'),
    blue:          slot(4, '#7aa2f7'),
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
export function contrastRatio(a: string, b: string): number {
  const luminance = (c: string) => {
    const rgb = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
  }
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}
export function applyPaletteToCSS(p: ThemePalette): void {
  const r = document.documentElement.style
  r.setProperty('--bs-bg',       p.background)
  r.setProperty('--bs-bg-dark',  p.background)
  r.setProperty('--bs-fg',       p.foreground)
  // Derive surface/border/muted from palette slots rather than hardcoding.
  // bg-elev: a slightly lighter shade — use bright-black slot if it contrasts,
  // otherwise stay close to background (we don't have a dedicated slot for this).
  r.setProperty('--bs-bg-elev', mixColor(p.background, p.foreground, .055))
  r.setProperty('--bs-bg-float', mixColor(p.background, p.foreground, .035))
  r.setProperty('--bs-border', mixColor(p.background, p.foreground, .18))
  r.setProperty('--bs-border-faint', mixColor(p.background, p.foreground, .09))
  const readable = (fraction: number) => {
    const candidate = mixColor(p.background, p.foreground, fraction)
    return contrastRatio(candidate, mixColor(p.background, p.foreground, .055)) >= 4.5 ? candidate : p.foreground
  }
  r.setProperty('--bs-fg-muted', readable(.78))
  r.setProperty('--bs-fg-faint', readable(.62))
  r.setProperty('--bs-red',      p.red)
  r.setProperty('--bs-green',    p.green)
  r.setProperty('--bs-yellow',   p.yellow)
  r.setProperty('--bs-cyan',     p.cyan)
  r.setProperty('--bs-magenta',  p.magenta)
  r.setProperty('--bs-purple',   p.magenta)
  // --bs-blue is the accent; clamp so it's never purple-dominant (plan rule).
  const accent = contrastRatio(p.blue, p.background) >= 4.5 ? p.blue : mixColor(p.blue, p.foreground, .65)
  r.setProperty('--bs-blue',     accent)
  r.setProperty('--bs-accent',   accent)
  r.setProperty('color-scheme', contrastRatio(p.background, '#000000') > contrastRatio(p.background, '#ffffff') ? 'light' : 'dark')
  r.setProperty('--bs-orange',   p.yellow) // ghostty themes often lack orange; fall back to yellow
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
