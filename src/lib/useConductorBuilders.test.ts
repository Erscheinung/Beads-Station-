import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// RV8.1 — useConductorBuilders merges per-builder `conductor_builder` events into
// a live map keyed by bead_id, and prunes terminal (awake/error) entries after a
// short TTL. We mock safeListen per-channel so this hook's listener is isolated
// from useConductorStatus/useConductorFeed (which listen on conductor_status).

const handlers: Record<string, (e: { payload: unknown }) => void> = {}

vi.mock('./safeListen', () => ({
  safeListen: (channel: string, handler: (e: { payload: unknown }) => void) => {
    handlers[channel] = handler
    return Promise.resolve()
  },
}))

import { useConductorBuilders } from './useConductorStatus'
import { CONDUCTOR_BUILDER_EVENT, type BuilderStatus } from './conductorBridge'

function emitBuilder(b: Partial<BuilderStatus> & { bead_id: string; state: string }) {
  act(() => {
    handlers[CONDUCTOR_BUILDER_EVENT]?.({
      payload: {
        title: b.title ?? 'Some bead',
        epic_id: b.epic_id ?? 'Code-epic',
        model: b.model ?? 'claude-sonnet-5',
        tier: b.tier ?? 'M',
        detail: b.detail ?? null,
        last_pulse_ms: b.last_pulse_ms ?? 1000,
        ...b,
      },
    })
  })
}

describe('useConductorBuilders', () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k]
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('starts empty', () => {
    const { result } = renderHook(() => useConductorBuilders())
    expect(result.current).toEqual({})
  })

  it('tracks one entry per builder, keyed by bead_id', () => {
    const { result } = renderHook(() => useConductorBuilders())
    emitBuilder({ bead_id: 'Code-a', state: 'waking' })
    emitBuilder({ bead_id: 'Code-b', state: 'waking' })
    expect(Object.keys(result.current).sort()).toEqual(['Code-a', 'Code-b'])
    expect(result.current['Code-a'].state).toBe('waking')
  })

  it("replaces a builder's status in place on transition", () => {
    const { result } = renderHook(() => useConductorBuilders())
    emitBuilder({ bead_id: 'Code-a', state: 'waking' })
    emitBuilder({ bead_id: 'Code-a', state: 'blocked', detail: 'needs input' })
    expect(Object.keys(result.current)).toEqual(['Code-a'])
    expect(result.current['Code-a'].state).toBe('blocked')
    expect(result.current['Code-a'].detail).toBe('needs input')
  })

  it('prunes a terminal (awake) entry after the TTL', () => {
    const { result } = renderHook(() => useConductorBuilders())
    emitBuilder({ bead_id: 'Code-a', state: 'awake' })
    expect(result.current['Code-a'].state).toBe('awake')
    act(() => vi.advanceTimersByTime(4001))
    expect(result.current['Code-a']).toBeUndefined()
  })

  it('prunes a terminal (error) entry after the TTL', () => {
    const { result } = renderHook(() => useConductorBuilders())
    emitBuilder({ bead_id: 'Code-a', state: 'error', detail: 'boom' })
    act(() => vi.advanceTimersByTime(4001))
    expect(result.current['Code-a']).toBeUndefined()
  })

  it('keeps a blocked builder (no auto-prune — operator must act)', () => {
    const { result } = renderHook(() => useConductorBuilders())
    emitBuilder({ bead_id: 'Code-a', state: 'blocked' })
    act(() => vi.advanceTimersByTime(10000))
    expect(result.current['Code-a'].state).toBe('blocked')
  })

  it('a re-transition off a terminal state cancels the pending prune', () => {
    const { result } = renderHook(() => useConductorBuilders())
    emitBuilder({ bead_id: 'Code-a', state: 'awake' })
    // Before the prune fires, the same bead goes back to waking (a next tick).
    act(() => vi.advanceTimersByTime(2000))
    emitBuilder({ bead_id: 'Code-a', state: 'waking' })
    act(() => vi.advanceTimersByTime(4001))
    // The stale prune must NOT remove the now-active builder.
    expect(result.current['Code-a'].state).toBe('waking')
  })
})
