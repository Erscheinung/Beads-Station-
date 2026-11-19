import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { FOLLOW_POLL_MS, isRunningSession, lastTurnLabel, pendingNewTurns, useSessionFollow } from './follow'

const turn = (at: string | null) => ({ role: 'user' as const, at, blocks: [], files: [], thinking: 0 })

describe('follow helpers', () => {
  it('calls a session running only while its file changed in the last 20 seconds', () => {
    const now = 1_000_000_000_000
    expect(isRunningSession(now - 5_000, now)).toBe(true)
    expect(isRunningSession(now - 20_000, now)).toBe(true)
    expect(isRunningSession(now - 21_000, now)).toBe(false)
    expect(isRunningSession(0, now)).toBe(false)
  })
  it('says how long ago the last turn was', () => {
    const now = Date.parse('2026-11-20T12:00:00Z')
    expect(lastTurnLabel([turn('2026-11-20T11:00:00Z'), turn('2026-11-20T11:58:00Z')], null, now)).toBe('last turn 2m ago')
    expect(lastTurnLabel([turn(null)], now - 3 * 3_600_000, now)).toBe('last turn 3h ago')
    expect(lastTurnLabel([], 0, now)).toBeNull()
  })
  it('counts new turns only while scrolled away from the end', () => {
    expect(pendingNewTurns(null, 10, false, 0)).toBe(0)
    expect(pendingNewTurns(10, 12, false, 0)).toBe(2)
    expect(pendingNewTurns(12, 13, false, 2)).toBe(3)
    expect(pendingNewTurns(10, 12, true, 5)).toBe(0)
    expect(pendingNewTurns(12, 12, false, 2)).toBe(2)
  })
})

describe('useSessionFollow', () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.invoke.mockReset() })
  afterEach(() => vi.useRealTimers())

  it('re-reads only when the file stamp changed, and not while the window is hidden', async () => {
    let stamp = { modifiedMs: 1, bytes: 10 }
    let turns = 1
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'transcript_stamp') return stamp
      if (cmd === 'transcript_read') return { id: 's', provider: 'claude', truncated: false, usage: null, turns: Array.from({ length: turns }, () => turn(null)) }
      return null
    })
    const reads = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'transcript_read').length
    const { result } = renderHook(() => useSessionFollow({ cwd: '/w', provider: 'claude', sessionId: 's' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(reads()).toBe(1)
    expect(result.current.transcript?.turns.length).toBe(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(FOLLOW_POLL_MS * 3) })
    expect(reads()).toBe(1)

    stamp = { modifiedMs: 2, bytes: 40 }; turns = 3
    await act(async () => { await vi.advanceTimersByTimeAsync(FOLLOW_POLL_MS) })
    expect(reads()).toBe(2)
    expect(result.current.transcript?.turns.length).toBe(3)

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    stamp = { modifiedMs: 3, bytes: 80 }
    await act(async () => { await vi.advanceTimersByTimeAsync(FOLLOW_POLL_MS * 2) })
    expect(reads()).toBe(2)
    visibility.mockRestore()
  })

  it('reads nothing without a session id', async () => {
    renderHook(() => useSessionFollow({ cwd: '/w', provider: 'claude', sessionId: null }))
    await act(async () => { await vi.advanceTimersByTimeAsync(FOLLOW_POLL_MS * 2) })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
