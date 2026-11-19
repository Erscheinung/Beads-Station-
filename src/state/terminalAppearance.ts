import { useSyncExternalStore } from 'react'
import { persistDurableUserConfigKey } from '../lib/durableUserConfig'
import { getActivePalette } from './theme'
const KEY = 'beads-station.terminal-appearance'
export const TERMINAL_FONTS = ['JetBrains Mono', 'Menlo', 'Monaco', 'monospace']
/** Typed shell commands: the theme's own colour, a custom hex, or left alone. */
export type CmdColorMode = 'theme' | 'custom' | 'off'
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
export interface TerminalAppearance {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  scrollback: number
  /** Cmd+arrows, Cmd+Backspace, Shift+Enter and friends act as in macOS terminals. */
  macEditingKeys: boolean
  /** Finishing a mouse selection in a terminal copies it, as in iTerm and Ghostty. */
  copyOnSelect: boolean
  /** Colour of the command you type at the prompt, to tell it from output. Applies to new shells. */
  cmdColorMode: CmdColorMode
  cmdColorCustom: string
}
export const DEFAULT_TERMINAL_APPEARANCE: TerminalAppearance = {
  fontFamily: 'JetBrains Mono', fontSize: 13, lineHeight: 1.2,
  cursorStyle: 'block', cursorBlink: true, scrollback: 3000,
  macEditingKeys: true,
  copyOnSelect: true,
  cmdColorMode: 'theme', cmdColorCustom: '#fd9f4d',
}
function validated(next: Partial<TerminalAppearance>, base: TerminalAppearance): TerminalAppearance {
  const result = { ...base }
  if (TERMINAL_FONTS.includes(next.fontFamily!)) result.fontFamily = next.fontFamily!
  if (typeof next.fontSize === 'number' && next.fontSize >= 10 && next.fontSize <= 24) result.fontSize = next.fontSize
  if (typeof next.lineHeight === 'number' && next.lineHeight >= 1 && next.lineHeight <= 1.8) result.lineHeight = next.lineHeight
  if (['block', 'bar', 'underline'].includes(next.cursorStyle!)) result.cursorStyle = next.cursorStyle!
  if (typeof next.cursorBlink === 'boolean') result.cursorBlink = next.cursorBlink
  if (typeof next.scrollback === 'number' && Number.isInteger(next.scrollback) && next.scrollback >= 100 && next.scrollback <= 50000) result.scrollback = next.scrollback
  if (typeof next.macEditingKeys === 'boolean') result.macEditingKeys = next.macEditingKeys
  if (typeof next.copyOnSelect === 'boolean') result.copyOnSelect = next.copyOnSelect
  if (['theme', 'custom', 'off'].includes(next.cmdColorMode!)) result.cmdColorMode = next.cmdColorMode!
  if (typeof next.cmdColorCustom === 'string' && HEX_COLOR.test(next.cmdColorCustom)) result.cmdColorCustom = next.cmdColorCustom.toLowerCase()
  return result
}
let state = { ...DEFAULT_TERMINAL_APPEARANCE }
try { state = validated(JSON.parse(localStorage.getItem(KEY) || '{}'), state) } catch { /* optional storage */ }
const listeners = new Set<() => void>()
export const getTerminalAppearance = () => state
export function subscribeTerminalAppearance(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function useTerminalAppearance() { return useSyncExternalStore(subscribeTerminalAppearance, getTerminalAppearance) }
export function setTerminalAppearance(next: Partial<TerminalAppearance>) {
  state = validated(next, state)
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* optional storage */ }
  persistDurableUserConfigKey(KEY)
  listeners.forEach(l => l())
}
export const TERMINAL_FONT_SIZE = { min: 10, max: 24 }
/** Step the terminal text size, or return it to the default with `null`. */
export function stepTerminalFontSize(delta: 1 | -1 | null) {
  const fontSize = delta === null
    ? DEFAULT_TERMINAL_APPEARANCE.fontSize
    : Math.min(TERMINAL_FONT_SIZE.max, Math.max(TERMINAL_FONT_SIZE.min, state.fontSize + delta))
  if (fontSize !== state.fontSize) setTerminalAppearance({ fontSize })
}
export function resetTerminalAppearance() { setTerminalAppearance(DEFAULT_TERMINAL_APPEARANCE) }

/**
 * The `#rrggbb` a new shell should colour typed commands with, or null for off.
 * "Theme default" is the active theme's own command colour (orange for Fahrenheit).
 */
export function resolveCmdColor(appearance: TerminalAppearance = state, themeDefault: string | undefined = getActivePalette()?.cmdColor): string | null {
  if (appearance.cmdColorMode === 'off') return null
  const hex = appearance.cmdColorMode === 'custom' ? appearance.cmdColorCustom : themeDefault
  return hex && HEX_COLOR.test(hex) ? hex.toLowerCase() : null
}
