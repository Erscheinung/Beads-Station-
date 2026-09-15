import { useSyncExternalStore } from 'react'
import { openPalette } from './palette'
import { openSettings } from './settings'

export const COMMANDS = [
  { id: 'palette', label: 'Command palette', binding: 'Mod+K' },
  { id: 'settings', label: 'Settings', binding: 'Mod+,' },
  { id: 'workspace', label: 'Open workspace' },
  { id: 'projects', label: 'Switch project' },
  { id: 'newIssue', label: 'New issue', repo: true },
  { id: 'ready', label: 'Claim ready', repo: true },
  { id: 'grep', label: 'Search beads / issue explorer', repo: true },
  { id: 'toggleTheme', label: 'Toggle theme' },
  { id: 'themes', label: 'Choose theme' },
  { id: 'layout', label: 'View settings' },
  { id: 'designer', label: 'Switch to designer skin' },
  { id: 'terminal', label: 'Switch to terminal skin' },
  { id: 'newTab', label: 'New terminal tab', repo: true },
  { id: 'splitH', label: 'Split terminal horizontally', repo: true },
  { id: 'splitV', label: 'Split terminal vertically', repo: true },
  { id: 'unsplit', label: 'Unsplit terminal to tabs (keep sessions)', repo: true },
  { id: 'closePane', label: 'Close focused terminal pane', repo: true },
  { id: 'zoomPane', label: 'Zoom / restore terminal pane', repo: true },
  { id: 'fullscreen', label: 'Fullscreen terminal focus', binding: 'Mod+Shift+Enter', repo: true },
  { id: 'focusLeft', label: 'Focus terminal pane left', binding: 'Mod+Alt+ArrowLeft', repo: true },
  { id: 'focusRight', label: 'Focus terminal pane right', binding: 'Mod+Alt+ArrowRight', repo: true },
  { id: 'focusUp', label: 'Focus terminal pane up', binding: 'Mod+Alt+ArrowUp', repo: true },
  { id: 'focusDown', label: 'Focus terminal pane down', binding: 'Mod+Alt+ArrowDown', repo: true },
  { id: 'resizeLeft', label: 'Resize terminal split left', binding: 'Mod+Alt+Shift+ArrowLeft', repo: true },
  { id: 'resizeRight', label: 'Resize terminal split right', binding: 'Mod+Alt+Shift+ArrowRight', repo: true },
  { id: 'resizeUp', label: 'Resize terminal split up', binding: 'Mod+Alt+Shift+ArrowUp', repo: true },
  { id: 'resizeDown', label: 'Resize terminal split down', binding: 'Mod+Alt+Shift+ArrowDown', repo: true },
  { id: 'agent', label: 'New Claude agent pane', repo: true },
  { id: 'files', label: 'Open files explorer', repo: true },
  { id: 'expand', label: 'Expand all beads', repo: true },
  { id: 'collapse', label: 'Collapse bead groups', repo: true },
  { id: 'hideExplorer', label: 'Collapse explorer' },
] satisfies { id: string; label: string; binding?: string; repo?: boolean }[]
export type CommandId = typeof COMMANDS[number]['id']

export interface LeaderShortcut {
  key: string
  label: string
}

// Leader chords are intentionally not configurable: they are the small,
// context-sensitive navigation layer used to keep editor and shell input
// untouched. These tables are the single source for WhichKey and Settings.
export const LEADER_SHORTCUTS: Record<'global' | 'terminal', readonly LeaderShortcut[]> = {
  global: [
    { key: 'p', label: 'Cycle project' },
    { key: 'k', label: 'Command palette' },
    { key: '\\', label: 'Toggle explorer' },
    { key: 'b', label: 'Focus board' },
    { key: 'c', label: 'Focus chat' },
    { key: 's', label: 'Focus sidebar' },
    { key: 'a', label: 'New agent pane' },
    { key: 'e', label: 'Open files explorer' },
    { key: 'q', label: 'Quit' },
  ],
  terminal: [
    { key: 's', label: 'Split terminal horizontally' },
    { key: 'v', label: 'Split terminal vertically' },
    { key: 't', label: 'New terminal tab' },
    { key: 'z', label: 'Zoom / restore terminal pane' },
    { key: 'a', label: 'New agent pane' },
    { key: 'e', label: 'Open files explorer' },
    { key: 'x', label: 'Close focused terminal pane' },
    { key: 'b', label: 'Focus board' },
    { key: 'c', label: 'Focus chat' },
    { key: 'p', label: 'Cycle project' },
    { key: '1–9', label: 'Switch terminal tab' },
  ],
}
const KEY = 'beads-station.command-bindings.v1'
const defaults: Record<string, string> = Object.fromEntries(COMMANDS.map(c => [c.id, ('binding' in c ? c.binding : '') || '']))
let bindings = { ...defaults }
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
  for (const id of Object.keys(defaults)) if (typeof saved[id] === 'string') bindings[id] = saved[id]
  for (const id of Object.keys(defaults)) if (bindingError(id, bindings[id])) bindings[id] = ''
} catch { /* optional storage */ }
const listeners = new Set<() => void>()
export function useCommandBindings() {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => bindings)
}
export function getBinding(id: string) { return bindings[id] || '' }
export function shortcutLabel(binding: string) {
  return binding.replace('Mod', /Mac|iPhone|iPad/.test(navigator.platform) ? '\u2318' : 'Ctrl').replace(/\+/g, ' ')
}
export function eventBinding(e: KeyboardEvent): string {
  if (!(e.metaKey || e.ctrlKey) || (e.metaKey && e.ctrlKey) || ['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return ''
  return ['Mod', ...(e.altKey ? ['Alt'] : []), ...(e.shiftKey ? ['Shift'] : []), e.key.length === 1 ? e.key.toUpperCase() : e.key].join('+')
}
export function bindingError(id: string, binding: string): string | null {
  if (!binding) return null
  if (!/^Mod\+(Alt\+)?(Shift\+)?([^+]|Enter|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(binding)) return 'Use Command or Control with a letter, number, or punctuation key.'
  if (['Mod+P', 'Mod+W', 'Mod+Q', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+A', 'Mod+Z', 'Mod+Shift+Z', 'Mod+R'].includes(binding)) return 'Reserved for pane controls, editing, or the application.'
  const conflict = COMMANDS.find(c => c.id !== id && bindings[c.id] === binding)
  return conflict ? `Already assigned to ${conflict.label}.` : null
}
export function setBinding(id: string, binding: string): string | null {
  if (!(id in defaults)) return 'Unknown command.'
  const error = bindingError(id, binding)
  if (error) return error
  bindings = { ...bindings, [id]: binding }
  try { localStorage.setItem(KEY, JSON.stringify(bindings)) } catch { /* optional storage */ }
  listeners.forEach(l => l())
  return null
}
export function resetBindings() {
  bindings = { ...defaults }
  try { localStorage.removeItem(KEY) } catch { /* optional storage */ }
  listeners.forEach(l => l())
}
export function matchedCommand(e: KeyboardEvent): CommandId | undefined {
  if (e.isComposing) return
  const binding = eventBinding(e)
  return binding ? COMMANDS.find(c => bindings[c.id] === binding)?.id : undefined
}
export function dispatchCommand(id: CommandId) {
  if (id === 'palette') { openPalette(); return }
  if (id === 'settings') { openSettings(); return }
  if (id === 'fullscreen') { window.dispatchEvent(new CustomEvent('terminal:focus-toggle')); return }
  window.dispatchEvent(new CustomEvent('bs:command', { detail: id }))
}
