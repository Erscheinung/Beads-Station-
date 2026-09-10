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
  { id: 'agent', label: 'New Claude agent pane', repo: true },
  { id: 'files', label: 'Open files explorer', repo: true },
  { id: 'expand', label: 'Expand all beads', repo: true },
  { id: 'collapse', label: 'Collapse bead groups', repo: true },
  { id: 'hideExplorer', label: 'Collapse explorer' },
] satisfies { id: string; label: string; binding?: string; repo?: boolean }[]
export type CommandId = typeof COMMANDS[number]['id']
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
  if (['Mod+P', 'Mod+Enter', 'Mod+W', 'Mod+Q', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+A', 'Mod+Z', 'Mod+Shift+Z', 'Mod+R'].includes(binding)) return 'Reserved for pane controls, editing, or the application.'
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
  window.dispatchEvent(new CustomEvent('bs:command', { detail: id }))
}
