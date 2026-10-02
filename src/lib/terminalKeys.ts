// macOS line-editing chords for terminal panes, matching what Terminal.app,
// iTerm ("Natural Text Editing") and Ghostty send. xterm.js already maps
// Option+Left/Right to word motion and Option+Backspace to delete-word; this
// table adds the chords it leaves out.

export type TerminalKeyAction =
  | { kind: 'send'; data: string }
  | { kind: 'scroll'; to: 'top' | 'bottom' }

export interface TerminalKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const ESC = '\u001b'

/**
 * Resolve a key event to a terminal action, or null to leave it to xterm.
 * Readline control codes are only sent in the normal buffer: a full-screen
 * application such as Neovim would read Ctrl-A or Ctrl-U as its own command.
 */
export function macTerminalKeyAction(event: TerminalKeyEvent, buffer: 'normal' | 'alternate'): TerminalKeyAction | null {
  const { key, metaKey, ctrlKey, altKey, shiftKey } = event
  if (ctrlKey) return null
  const normal = buffer === 'normal'

  if (metaKey && !altKey && !shiftKey) {
    switch (key) {
      case 'ArrowLeft': return { kind: 'send', data: normal ? '\u0001' : `${ESC}[H` }
      case 'ArrowRight': return { kind: 'send', data: normal ? '\u0005' : `${ESC}[F` }
      case 'Backspace': return normal ? { kind: 'send', data: '\u0015' } : null
      case 'Delete': return normal ? { kind: 'send', data: '\u000b' } : null
      case 'ArrowUp': return normal ? { kind: 'scroll', to: 'top' } : null
      case 'ArrowDown': return normal ? { kind: 'scroll', to: 'bottom' } : null
    }
    return null
  }

  if (altKey && !metaKey && !shiftKey && key === 'Delete') {
    return normal ? { kind: 'send', data: `${ESC}d` } : null
  }

  // Claude Code and Codex read ESC+CR as "insert a newline" in their prompt.
  if (shiftKey && !metaKey && !altKey && key === 'Enter') {
    return normal ? { kind: 'send', data: `${ESC}\r` } : null
  }

  return null
}
