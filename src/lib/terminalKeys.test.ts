import { describe, expect, it } from 'vitest'
import { macTerminalKeyAction, type TerminalKeyEvent } from './terminalKeys'

const key = (name: string, modifiers: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent => ({
  key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers,
})

describe('macOS terminal editing chords', () => {
  it('maps Command chords to readline control codes at a shell prompt', () => {
    expect(macTerminalKeyAction(key('ArrowLeft', { metaKey: true }), 'normal')).toEqual({ kind: 'send', data: '\u0001' })
    expect(macTerminalKeyAction(key('ArrowRight', { metaKey: true }), 'normal')).toEqual({ kind: 'send', data: '\u0005' })
    expect(macTerminalKeyAction(key('Backspace', { metaKey: true }), 'normal')).toEqual({ kind: 'send', data: '\u0015' })
    expect(macTerminalKeyAction(key('Delete', { metaKey: true }), 'normal')).toEqual({ kind: 'send', data: '\u000b' })
    expect(macTerminalKeyAction(key('Delete', { altKey: true }), 'normal')).toEqual({ kind: 'send', data: '\u001bd' })
  })
  it('scrolls history with Command+Up/Down and inserts a newline with Shift+Enter', () => {
    expect(macTerminalKeyAction(key('ArrowUp', { metaKey: true }), 'normal')).toEqual({ kind: 'scroll', to: 'top' })
    expect(macTerminalKeyAction(key('ArrowDown', { metaKey: true }), 'normal')).toEqual({ kind: 'scroll', to: 'bottom' })
    expect(macTerminalKeyAction(key('Enter', { shiftKey: true }), 'normal')).toEqual({ kind: 'send', data: '\u001b\r' })
  })
  it('never sends readline control codes to a full-screen application', () => {
    expect(macTerminalKeyAction(key('ArrowLeft', { metaKey: true }), 'alternate')).toEqual({ kind: 'send', data: '\u001b[H' })
    expect(macTerminalKeyAction(key('ArrowRight', { metaKey: true }), 'alternate')).toEqual({ kind: 'send', data: '\u001b[F' })
    for (const event of [key('Backspace', { metaKey: true }), key('Delete', { metaKey: true }), key('Delete', { altKey: true }), key('ArrowUp', { metaKey: true }), key('Enter', { shiftKey: true })]) {
      expect(macTerminalKeyAction(event, 'alternate')).toBeNull()
    }
  })
  it('leaves plain keys, Control chords and app-style chords to xterm and the app', () => {
    expect(macTerminalKeyAction(key('ArrowLeft'), 'normal')).toBeNull()
    expect(macTerminalKeyAction(key('Enter'), 'normal')).toBeNull()
    expect(macTerminalKeyAction(key('ArrowLeft', { ctrlKey: true }), 'normal')).toBeNull()
    expect(macTerminalKeyAction(key('ArrowLeft', { metaKey: true, altKey: true }), 'normal')).toBeNull()
    expect(macTerminalKeyAction(key('ArrowLeft', { metaKey: true, shiftKey: true }), 'normal')).toBeNull()
    expect(macTerminalKeyAction(key('ArrowLeft', { altKey: true }), 'normal')).toBeNull()
  })
})
