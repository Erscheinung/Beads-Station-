import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

// ---------------------------------------------------------------------------
// RV3.4 regression: leader can be armed from a focused editable via Cmd/Ctrl-P.
//
// The bug: a bare Space cannot arm the leader while an editable (Claude/agent
// input, xterm, legacy chat) holds focus — the editable owns the keystroke, so
// useVimNav's editable bypass (or the terminal insert-mode return) swallows it.
// leaderChordActive only lets the SECOND chord key through, never the first
// Space that ARMS leader. Result: with focus in the chat textarea, all <leader>
// project commands were dead.
//
// The fix: a global Cmd-P (mac) / Ctrl-P chord, handled at the very top of the
// keydown handler (before the terminal block and the editable bypass), blurs
// the editable, drops insert mode, and arms leader with the same persistent
// semantics as bare Space. The next key then resolves via the normal leader
// switch.
//
// We assert (1) Cmd-P from a focused <input> arms leader, and (2) the armed
// second key resolves (b -> focus board). Mutation check: reverting the fix
// makes Cmd-P a no-op, so leaderActive stays false and focus never changes.
// ---------------------------------------------------------------------------

// useVimNav imports invoke (agent-kill on <leader>x) and killPty; neither fires
// on the arm path, but the module must import cleanly under jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}))
vi.mock('../components/TerminalPanes', () => ({
  killPty: vi.fn(),
}))

import { useVimNav } from './useVimNav'
import { setFocused, setLeaderActive } from '../state/vim'
import { closePalette } from '../state/palette'
import { resetBindings, setBinding } from '../state/commands'

function Harness() {
  useVimNav()
  return <input data-testid="chat-input" />
}

interface VimMirror {
  leaderActive: boolean
  focused: string
}

function vimMirror(): VimMirror {
  return (window as unknown as { __bsVim: VimMirror }).__bsVim
}

function press(key: string, opts: KeyboardEventInit = {}): void {
  // Dispatch from the focused element (or body) so event.target is a real
  // node that bubbles to the window handler — mirrors browser retargeting,
  // which jsdom does NOT apply to window.dispatchEvent.
  const target = (document.activeElement as HTMLElement | null) ?? document.body
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }),
  )
}

describe('useVimNav — RV3.4 Cmd-P leader escape hatch', () => {
  beforeEach(() => {
    setLeaderActive(false)
    setFocused('chat') // legacy-chat regime, NOT terminal
  })
  afterEach(() => {
    setLeaderActive(false)
    setFocused('board')
  })

  it('leaves form typing and modal traversal alone while terminal has logical focus', () => {
    const { getByTestId } = render(<Harness />)
    const input = getByTestId('chat-input') as HTMLInputElement
    setFocused('terminal')
    input.focus()
    for (const key of ['a', ' ', 'i', 'Enter', 'Escape']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(input)
    }
    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    document.body.append(dialog)
    const originalParent = input.parentElement!
    dialog.append(input)
    const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    input.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    originalParent.append(input)
    dialog.remove()
  })

  it('Cmd-P arms leader even while a text input holds focus', () => {
    const { getByTestId } = render(<Harness />)
    const input = getByTestId('chat-input') as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)

    // Bare Space must NOT arm here (it's a real space in the input).
    press(' ')
    expect(vimMirror().leaderActive).toBe(false)

    // Cmd-P arms leader and blurs the input so the next key lands cleanly.
    press('p', { metaKey: true })
    expect(vimMirror().leaderActive).toBe(true)
    expect(document.activeElement).not.toBe(input)
  })

  it('the armed second key resolves (b -> focus board)', () => {
    render(<Harness />)
    press('p', { ctrlKey: true }) // Ctrl-P works too (non-mac)
    expect(vimMirror().leaderActive).toBe(true)

    press('b')
    expect(vimMirror().focused).toBe('board')
    expect(vimMirror().leaderActive).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Phase 9 (Code-ky4.9) — command palette open bindings.
//   Cmd/Ctrl+K opens from any focus; leader-k opens via the leader switch.
//   Cmd+P must still arm the leader (NOT open the palette) — no regression.
// ---------------------------------------------------------------------------
interface PaletteMirror {
  open: boolean
}
function paletteMirror(): PaletteMirror {
  return (window as unknown as { __bsPalette: PaletteMirror }).__bsPalette
}

describe('useVimNav — Phase 9 palette open', () => {
  beforeEach(() => {
    setLeaderActive(false)
    setFocused('board')
    closePalette()
    resetBindings()
  })
  afterEach(() => {
    closePalette()
    setLeaderActive(false)
  })

  it('Cmd+K opens the palette even while an input holds focus', () => {
    const { getByTestId } = render(<Harness />)
    const input = getByTestId('chat-input') as HTMLInputElement
    input.focus()
    expect(paletteMirror().open).toBe(false)
    press('k', { metaKey: true })
    expect(paletteMirror().open).toBe(true)
    expect(document.activeElement).not.toBe(input)
  })

  it('leader-k opens the palette', () => {
    render(<Harness />)
    press(' ') // arm leader (board focus, bare Space arms)
    expect(vimMirror().leaderActive).toBe(true)
    press('k')
    expect(paletteMirror().open).toBe(true)
    expect(vimMirror().leaderActive).toBe(false)
  })

  it('Cmd+P still arms leader and does NOT open the palette', () => {
    render(<Harness />)
    press('p', { metaKey: true })
    expect(vimMirror().leaderActive).toBe(true)
    expect(paletteMirror().open).toBe(false)
  })

  it('dispatches a recorded command from the focused surface', () => {
    render(<Harness />)
    expect(setBinding('workspace', 'Mod+Shift+O')).toBeNull()
    const received: string[] = []
    const onCommand = (event: Event) => received.push((event as CustomEvent<string>).detail)
    window.addEventListener('bs:command', onCommand)

    press('o', { metaKey: true, shiftKey: true })

    window.removeEventListener('bs:command', onCommand)
    expect(received).toEqual(['workspace'])
  })
})
