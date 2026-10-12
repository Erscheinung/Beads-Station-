import { useSyncExternalStore } from 'react'
import { openPalette } from './palette'
import { openSettings } from './settings'
import { persistDurableUserConfigKey } from '../lib/durableUserConfig'

export const COMMANDS = [
  { id: 'palette', label: 'Command palette', binding: 'Mod+K' },
  { id: 'settings', label: 'Settings', binding: 'Mod+,' },
  { id: 'workspace', label: 'Open workspace' },
  { id: 'initializeBeads', label: 'Initialize Beads in workspace', repo: true },
  { id: 'projects', label: 'Switch project' },
  { id: 'newIssue', label: 'New issue', repo: true },
  { id: 'ready', label: 'Claim ready', repo: true },
  { id: 'grep', label: 'Search beads / issue explorer', repo: true },
  { id: 'toggleTheme', label: 'Toggle theme' },
  { id: 'themes', label: 'Choose theme' },
  { id: 'layout', label: 'View settings' },
  { id: 'showBoard', label: 'Show board' },
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
  { id: 'terminalFontLarger', label: 'Terminal text larger', binding: 'Mod+=' },
  { id: 'terminalFontSmaller', label: 'Terminal text smaller', binding: 'Mod+-' },
  { id: 'terminalFontReset', label: 'Terminal text default size', binding: 'Mod+0' },
  { id: 'notificationJump', label: 'Jump to latest pane notification', binding: 'Mod+Shift+U' },
  { id: 'notificationPanel', label: 'Show waiting panes', binding: 'Mod+I' },
  { id: 'notificationsClear', label: 'Clear pane notifications' },
  { id: 'checkForUpdates', label: 'Check for updates' },
  { id: 'agent', label: 'New Claude agent pane', repo: true },
  { id: 'files', label: 'Open files explorer', repo: true },
  { id: 'browser', label: 'Open browser pane', binding: 'Mod+Shift+L', repo: true },
  { id: 'expand', label: 'Expand all beads', repo: true },
  { id: 'collapse', label: 'Collapse bead groups', repo: true },
  { id: 'hideExplorer', label: 'Collapse explorer' },
  { id: 'workspacePrevious', label: 'Previous workspace', binding: 'Mod+Alt+[' },
  { id: 'workspaceNext', label: 'Next workspace', binding: 'Mod+Alt+]' },
  { id: 'workspaceMoveLeft', label: 'Move workspace tab left', repo: true },
  { id: 'workspaceMoveRight', label: 'Move workspace tab right', repo: true },
  { id: 'terminalPrevious', label: 'Previous terminal tab', binding: 'Mod+Shift+[', repo: true },
  { id: 'terminalNext', label: 'Next terminal tab', binding: 'Mod+Shift+]', repo: true },
  { id: 'terminalMoveLeft', label: 'Move terminal tab left', repo: true },
  { id: 'terminalMoveRight', label: 'Move terminal tab right', repo: true },
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `workspaceSelect${index + 1}`,
    label: `Select workspace ${index + 1}`,
    binding: `Mod+Alt+${index + 1}`,
  })),
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `terminalSelect${index + 1}`,
    label: `Select terminal tab ${index + 1}`,
    binding: `Mod+Shift+${index + 1}`,
    repo: true,
  })),
] satisfies { id: string; label: string; binding?: string; repo?: boolean }[]
export type CommandId = typeof COMMANDS[number]['id'] | `recipe:${string}`

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
const RECIPE_KEY = 'beads-station.recipe-bindings.v1'
const defaults: Record<string, string> = Object.fromEntries(COMMANDS.map(c => [c.id, ('binding' in c ? c.binding : '') || '']))
let bindings = { ...defaults }
let recipeBindings: Record<string, { label: string; binding: string }> = {}
// Commands with no saved entry are new since the user last changed a shortcut.
const unsavedIds = new Set(Object.keys(defaults))
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
  for (const id of Object.keys(defaults)) {
    if (typeof saved[id] !== 'string') continue
    bindings[id] = saved[id]
    unsavedIds.delete(id)
  }
  // A command added by an update must not take a shortcut the user already
  // assigned: the new default yields, never the user's choice.
  if (unsavedIds.size < Object.keys(defaults).length) {
    const chosen = new Set(Object.keys(defaults).filter(id => !unsavedIds.has(id)).map(id => bindings[id]))
    for (const id of unsavedIds) if (bindings[id] && chosen.has(bindings[id])) bindings[id] = ''
  }
  for (const id of Object.keys(defaults)) if (bindingError(id, bindings[id])) bindings[id] = ''
} catch { /* optional storage */ }
try {
  const saved = JSON.parse(localStorage.getItem(RECIPE_KEY) || '{}')
  if (saved && typeof saved === 'object') {
    for (const [id, value] of Object.entries(saved)) {
      if (typeof value === 'object' && value !== null && typeof (value as { label?: unknown }).label === 'string' && typeof (value as { binding?: unknown }).binding === 'string') {
        recipeBindings[id] = { label: (value as { label: string }).label, binding: (value as { binding: string }).binding }
      }
    }
  }
  // The same rule for recipe shortcuts recorded before a command existed.
  const recipeChosen = new Set(Object.values(recipeBindings).map(value => value.binding))
  for (const id of unsavedIds) if (bindings[id] && recipeChosen.has(bindings[id])) bindings[id] = ''
} catch { /* optional storage */ }
const listeners = new Set<() => void>()
export function useCommandBindings() {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => bindings)
}
export function getBinding(id: string) { return bindings[id] || '' }
export function getRecipeBinding(recipeId: string) { return recipeBindings[recipeId]?.binding || '' }
export function getRecipeBindings() { return { ...recipeBindings } }
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform)
export function shortcutLabel(binding: string) {
  return binding.replace(/^Ctrl/, '\u2303').replace('Mod', isMac() ? '\u2318' : 'Ctrl').replace(/\+/g, ' ')
}
/**
 * The chord an event spells. `Mod` is Command on macOS and Control elsewhere.
 * On macOS a Control chord is spelled `Ctrl`: Command+Tab, Command+Space and
 * friends belong to the system and never reach the app, so Control is the
 * only way to bind Tab there.
 */
export function eventBinding(e: KeyboardEvent, mac = isMac()): string {
  if (!(e.metaKey || e.ctrlKey) || (e.metaKey && e.ctrlKey) || ['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return ''
  const modifier = mac && e.ctrlKey ? 'Ctrl' : 'Mod'
  return [modifier, ...(e.altKey ? ['Alt'] : []), ...(e.shiftKey ? ['Shift'] : []), e.key.length === 1 ? e.key.toUpperCase() : e.key].join('+')
}
export function bindingError(id: string, binding: string): string | null {
  if (!binding) return null
  if (!/^(Mod|Ctrl)\+(Alt\+)?(Shift\+)?([^+]|Enter|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(binding)) return 'Use Command or Control with a letter, number, punctuation key, Tab, Enter or an arrow.'
  // Control+letter is how a shell receives Ctrl-C, Ctrl-R, Ctrl-K and the rest.
  if (/^Ctrl\+[^+]$/.test(binding)) return 'Control with a single key is left to the shell. Add Shift or Option, or use Command.'
  if (['Mod+P', 'Mod+W', 'Mod+Q', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+A', 'Mod+Z', 'Mod+Shift+Z', 'Mod+R'].includes(binding)) return 'Reserved for pane controls, editing, or the application.'
  const conflict = COMMANDS.find(c => c.id !== id && bindings[c.id] === binding)
  if (conflict) return `Already assigned to ${conflict.label}.`
  const recipeConflict = Object.entries(recipeBindings).find(([recipeId, value]) => recipeId !== id && value.binding === binding)
  return recipeConflict ? `Already assigned to recipe ${recipeConflict[1].label}.` : null
}
export function setBinding(id: string, binding: string): string | null {
  if (!(id in defaults)) return 'Unknown command.'
  const error = bindingError(id, binding)
  if (error) return error
  bindings = { ...bindings, [id]: binding }
  try { localStorage.setItem(KEY, JSON.stringify(bindings)) } catch { /* optional storage */ }
  persistDurableUserConfigKey(KEY)
  listeners.forEach(l => l())
  return null
}
export function resetBindings() {
  bindings = { ...defaults }
  try { localStorage.removeItem(KEY) } catch { /* optional storage */ }
  persistDurableUserConfigKey(KEY)
  listeners.forEach(l => l())
}
function commandFor(binding: string): CommandId | undefined {
  const command = COMMANDS.find(c => bindings[c.id] === binding)?.id
  if (command) return command
  const recipe = Object.entries(recipeBindings).find(([, value]) => value.binding === binding)
  return recipe ? `recipe:${recipe[0]}` : undefined
}
export function matchedCommand(e: KeyboardEvent, mac = isMac()): CommandId | undefined {
  if (e.isComposing) return
  const binding = eventBinding(e, mac)
  if (!binding) return undefined
  const exact = commandFor(binding)
  if (exact || !binding.startsWith('Ctrl+')) return exact
  // macOS Control chord with no binding of its own. Control+key stays with
  // the shell; with Shift or Option it also answers to the Command binding.
  if (/^Ctrl\+[^+]$/.test(binding)) return undefined
  return commandFor(`Mod${binding.slice('Ctrl'.length)}`)
}
export function dispatchCommand(id: CommandId) {
  if (id === 'palette') { openPalette(); return }
  if (id === 'settings') { openSettings(); return }
  if (id === 'fullscreen') { window.dispatchEvent(new CustomEvent('terminal:focus-toggle')); return }
  if (id.startsWith('recipe:')) {
    window.dispatchEvent(new CustomEvent('recipe:run-binding', { detail: { recipeId: id.slice('recipe:'.length) } }))
    return
  }
  window.dispatchEvent(new CustomEvent('bs:command', { detail: id }))
}

/** Store recipe shortcuts alongside the normal binding registry so the one
 * global key handler can invoke them without a second keyboard listener. */
export function setRecipeBinding(recipeId: string, label: string, binding: string): string | null {
  const error = bindingError(recipeId, binding)
  if (error) return error
  recipeBindings = { ...recipeBindings, [recipeId]: { label, binding } }
  try { localStorage.setItem(RECIPE_KEY, JSON.stringify(recipeBindings)) } catch { /* optional storage */ }
  persistDurableUserConfigKey(RECIPE_KEY)
  listeners.forEach(l => l())
  return null
}

export function clearRecipeBinding(recipeId: string): void {
  if (!recipeBindings[recipeId]) return
  const next = { ...recipeBindings }
  delete next[recipeId]
  recipeBindings = next
  try { localStorage.setItem(RECIPE_KEY, JSON.stringify(recipeBindings)) } catch { /* optional storage */ }
  persistDurableUserConfigKey(RECIPE_KEY)
  listeners.forEach(l => l())
}
