import { describe, expect, it } from 'vitest'
import { PromptInputAccumulator } from './promptJournal'

function typed(...chunks: string[]): string[] {
  const acc = new PromptInputAccumulator()
  return chunks.flatMap(chunk => { const out = acc.feed(chunk); return out === null ? [] : [out] })
}

describe('PromptInputAccumulator', () => {
  it('submits the text typed before Enter', () => {
    expect(typed('h', 'e', 'l', 'l', 'o', '\r')).toEqual(['hello'])
  })

  it('applies Backspace, Ctrl+U and Ctrl+W', () => {
    expect(typed('helo\u007f', 'lo\r')).toEqual(['hello'])
    expect(typed('wrong\u0015right\r')).toEqual(['right'])
    expect(typed('fix the bug\u0017thing\r')).toEqual(['fix the thing'])
  })

  it('keeps a bracketed paste whole, newlines included, and submits only on Enter', () => {
    expect(typed('\u001b[200~line one\rline two\u001b[201~')).toEqual([])
    expect(typed('\u001b[200~line one\rline two\u001b[201~', '\r')).toEqual(['line one\nline two'])
  })

  it('ignores arrows, focus reports, mouse and OSC replies', () => {
    expect(typed('\u001b[A\u001b[I\u001b[<0;10;5M', 'ok', '\u001b]11;rgb:0000/0000/0000\u0007', '\u001b[?1;2c\r')).toEqual(['ok'])
  })

  it('treats Option+Enter and a lone line feed as a new line, not a submit', () => {
    expect(typed('a\u001b\rb\r')).toEqual(['a\nb'])
    expect(typed('a\nb\r')).toEqual(['a\nb'])
  })

  it('submits nothing for an empty line or after Ctrl+C', () => {
    expect(typed('\r', '   \r', 'oops\u0003\r')).toEqual([])
  })

  it('handles text and Enter arriving in one chunk, and Unicode', () => {
    expect(typed('héllo \u{1F642}\r')).toEqual(['héllo \u{1F642}'])
    expect(typed('a\u{1F642}\u007fb\r')).toEqual(['ab'])
  })

  it('reset forgets a half-typed line', () => {
    const acc = new PromptInputAccumulator()
    acc.feed('secret')
    acc.reset()
    expect(acc.feed('x\r')).toBe('x')
  })
})
