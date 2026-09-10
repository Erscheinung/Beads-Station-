import { beforeEach, describe, expect, it } from 'vitest'
import { eventBinding, getBinding, matchedCommand, resetBindings, setBinding } from './commands'

describe('command bindings', () => {
  beforeEach(resetBindings)
  it('rebinds the action and releases its old shortcut', () => {
    expect(setBinding('palette', 'Mod+Shift+L')).toBeNull()
    expect(matchedCommand(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))).toBeUndefined()
    expect(matchedCommand(new KeyboardEvent('keydown', { key: 'L', metaKey: true, shiftKey: true }))).toBe('palette')
    expect(JSON.parse(localStorage.getItem('beads-station.command-bindings.v1')!).palette).toBe('Mod+Shift+L')
  })
  it('rejects conflicts and protects editing, pane leader and Escape', () => {
    expect(setBinding('workspace', 'Mod+K')).toContain('Command palette')
    expect(setBinding('workspace', 'Mod+P')).toContain('Reserved')
    expect(setBinding('workspace', 'Mod+C')).toContain('Reserved')
    expect(setBinding('workspace', 'Mod+Escape')).toBeTruthy()
    expect(eventBinding(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe('')
    expect(getBinding('workspace')).toBe('')
  })
  it('leaves composition and unbound keys alone', () => {
    expect(matchedCommand(new KeyboardEvent('keydown', { key: 'k', metaKey: true, isComposing: true }))).toBeUndefined()
    setBinding('palette', '')
    expect(matchedCommand(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))).toBeUndefined()
  })
})
