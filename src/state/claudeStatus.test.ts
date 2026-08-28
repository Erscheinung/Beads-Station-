// Code-1cs (F4) — claudeStatus derives from the canonical claude_status
// channel ONLY. It used to ALSO listen claude_event (the full frame stream,
// the hottest channel) as a redundant fallback; that listener was dropped.
// These tests lock the invariant: no claude_event listener is ever armed, and
// each canonical claude_status payload drives the dot.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture every channel listen() is called with, plus its callback, so we can
// (a) assert claude_event is NOT among them and (b) drive claude_status frames.
const armed = new Map<string, (ev: { payload: unknown }) => void>()
const unlisten = vi.fn()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (channel: string, cb: (ev: { payload: unknown }) => void) => {
    armed.set(channel, cb)
    return unlisten
  }),
}))

import { subscribeClaudeStatus, getClaudeStatus } from './claudeStatus'

// startSubscription is async (awaits listen()); flush the microtask queue so
// the listeners are armed before we assert / drive them.
async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  armed.clear()
  unlisten.mockReset()
  vi.restoreAllMocks()
})

describe('claudeStatus canonical-only listeners (Code-1cs F4)', () => {
  let off: () => void
  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    off = subscribeClaudeStatus('p1', () => {})
    await flush()
  })
  afterEach(() => off?.())

  it('does NOT arm a claude_event listener', () => {
    const channels = [...armed.keys()]
    expect(channels).toContain('claude_status:p1')
    expect(channels.some(c => c.startsWith('claude_event'))).toBe(false)
  })

  it('drives status from claude_status payloads', () => {
    const cb = armed.get('claude_status:p1')!
    expect(getClaudeStatus('p1')).toBe('idle')
    cb({ payload: 'running' })
    expect(getClaudeStatus('p1')).toBe('running')
    cb({ payload: 'awaiting-input' })
    expect(getClaudeStatus('p1')).toBe('awaiting-input')
    cb({ payload: 'error' })
    expect(getClaudeStatus('p1')).toBe('error')
  })

  it('ignores an invalid claude_status payload', () => {
    const cb = armed.get('claude_status:p1')!
    cb({ payload: 'running' })
    cb({ payload: 'garbage' })
    expect(getClaudeStatus('p1')).toBe('running')
  })

  it('claude_stderr drives error', () => {
    const cb = armed.get('claude_stderr:p1')!
    cb({ payload: 'boom' })
    expect(getClaudeStatus('p1')).toBe('error')
  })
})
