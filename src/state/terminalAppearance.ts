import { useSyncExternalStore } from 'react'
import { persistDurableUserConfigKey } from '../lib/durableUserConfig'
const KEY = 'beads-station.terminal-appearance'
export const TERMINAL_FONTS = ['JetBrains Mono', 'Menlo', 'Monaco', 'monospace']
export interface TerminalAppearance {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  scrollback: number
}
export const DEFAULT_TERMINAL_APPEARANCE: TerminalAppearance = {
  fontFamily: 'JetBrains Mono', fontSize: 13, lineHeight: 1.2,
  cursorStyle: 'block', cursorBlink: true, scrollback: 3000,
}
function validated(next: Partial<TerminalAppearance>, base: TerminalAppearance): TerminalAppearance {
  const result = { ...base }
  if (TERMINAL_FONTS.includes(next.fontFamily!)) result.fontFamily = next.fontFamily!
  if (typeof next.fontSize === 'number' && next.fontSize >= 10 && next.fontSize <= 24) result.fontSize = next.fontSize
  if (typeof next.lineHeight === 'number' && next.lineHeight >= 1 && next.lineHeight <= 1.8) result.lineHeight = next.lineHeight
  if (['block', 'bar', 'underline'].includes(next.cursorStyle!)) result.cursorStyle = next.cursorStyle!
  if (typeof next.cursorBlink === 'boolean') result.cursorBlink = next.cursorBlink
  if (typeof next.scrollback === 'number' && Number.isInteger(next.scrollback) && next.scrollback >= 100 && next.scrollback <= 50000) result.scrollback = next.scrollback
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
export function resetTerminalAppearance() { setTerminalAppearance(DEFAULT_TERMINAL_APPEARANCE) }
