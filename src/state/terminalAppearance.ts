import { useSyncExternalStore } from 'react'
const KEY = 'beads-station.terminal-appearance'
export const TERMINAL_FONTS = ['JetBrains Mono', 'Menlo', 'Monaco', 'monospace']
let state = { fontFamily: 'JetBrains Mono', fontSize: 13, lineHeight: 1.2 }
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
  if (TERMINAL_FONTS.includes(saved.fontFamily)) state.fontFamily = saved.fontFamily
  if (saved.fontSize >= 10 && saved.fontSize <= 24) state.fontSize = saved.fontSize
  if (saved.lineHeight >= 1 && saved.lineHeight <= 1.8) state.lineHeight = saved.lineHeight
} catch { /* optional storage */ }
const listeners = new Set<() => void>()
export const getTerminalAppearance = () => state
export function useTerminalAppearance() { return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, getTerminalAppearance) }
export function setTerminalAppearance(next: Partial<typeof state>) {
  state = { ...state, ...next }
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* optional storage */ }
  listeners.forEach(l => l())
}
