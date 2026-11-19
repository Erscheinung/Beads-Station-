// Prompt journal (Code-7xc.2): every prompt submitted in an agent pane is kept
// in full, so a crash or a forced restart never loses a long one. The page
// reads what the user types into the terminal (xterm's onData), tracks it
// roughly, and on Enter hands the text to the backend. Only panes with an
// agent in the foreground feed it, so a password typed at a shell is never kept.

import { invoke } from '@tauri-apps/api/core'

const MAX_CHARS = 150_000
const ESC = '\u001b'

/**
 * Follows what has been typed since the last Enter. Rough on purpose: it knows
 * printable text, paste, Backspace, Ctrl+U, Ctrl+W and Ctrl+C, and ignores
 * every other control or escape sequence (arrows, focus reports, mouse).
 * Cursor movement is not modelled, so editing in the middle of a line can
 * differ from what the agent sees; the journal is a safety net, not a mirror.
 */
export class PromptInputAccumulator {
  private text = ''
  private pasting = false

  /** Returns the submitted prompt when `data` contains an Enter, else null. */
  feed(data: string): string | null {
    let submitted: string | null = null
    for (let i = 0; i < data.length; i++) {
      const c = data[i]
      if (c === ESC) {
        const next = data[i + 1]
        if (next === '[') {
          // CSI: parameters, then a final byte 0x40-0x7e.
          let j = i + 2
          while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) j++
          const body = data.slice(i + 2, j)
          if (data[j] === '~' && body === '200') this.pasting = true
          else if (data[j] === '~' && body === '201') this.pasting = false
          i = j
        } else if (next === ']') {
          // OSC: up to BEL or ESC \.
          let j = i + 2
          while (j < data.length && data[j] !== '\u0007' && !(data[j] === ESC && data[j + 1] === '\\')) j++
          i = data[j] === ESC ? j + 1 : j
        } else if (next === 'O') {
          i += 2
        } else if (next === '\r' || next === '\n') {
          // Option+Enter: a new line inside the prompt, not a submit.
          this.append('\n')
          i += 1
        } else if (next !== undefined) {
          i += 1
        }
        continue
      }
      if (this.pasting) {
        this.append(c === '\r' ? '\n' : c)
        continue
      }
      if (c === '\r') {
        const done = this.text.trim()
        this.text = ''
        if (done) submitted = submitted ? `${submitted}\n${done}` : done
      } else if (c === '\n') {
        this.append('\n')
      } else if (c === '\u007f' || c === '\b') {
        this.text = Array.from(this.text).slice(0, -1).join('')
      } else if (c === '\u0015' || c === '\u0003') {
        this.text = ''
      } else if (c === '\u0017') {
        this.text = this.text.replace(/\S+\s*$/, '')
      } else if (c >= ' ') {
        this.append(c)
      }
    }
    return submitted
  }

  private append(text: string) {
    if (this.text.length < MAX_CHARS) this.text += text
  }

  /** Forget what was typed (the agent left the pane). */
  reset() {
    this.text = ''
    this.pasting = false
  }
}

/** Keep one submitted prompt. Never throws: a journal must not get in the way of typing. */
export function journalPrompt(workspace: string, provider: string, text: string): void {
  void invoke('journal_append', { workspace, provider, text }).catch(() => { /* best effort */ })
}
