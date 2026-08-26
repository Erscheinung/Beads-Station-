import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

// Code-jx3.1 (RV6.1) — useConductorFeed accumulates conductor_status events into
// a capped, newest-first ring. We mock safeListen to capture the handler, then
// fire synthetic events and assert order + cap. (useConductorStatus is unchanged
// and covered indirectly by the panel tests.)

let captured: ((e: { payload: unknown }) => void) | null = null

vi.mock('./safeListen', () => ({
  safeListen: (_channel: string, handler: (e: { payload: unknown }) => void) => {
    captured = handler
    return Promise.resolve()
  },
}))

import { useConductorFeed } from './useConductorStatus'

function emit(state: string, bead_id: string | null, last_pulse_ms: number | null) {
  act(() => {
    captured?.({
      payload: {
        state,
        bead_id,
        detail: null,
        last_pulse_ms,
        interval_secs: 1200,
        repo_path: '/repo/a',
      },
    })
  })
}

describe('useConductorFeed', () => {
  beforeEach(() => {
    captured = null
  })

  it('starts empty', () => {
    const { result } = renderHook(() => useConductorFeed())
    expect(result.current).toEqual([])
  })

  it('accumulates newest-first', () => {
    const { result } = renderHook(() => useConductorFeed())
    emit('waking', 'Code-a', 1000)
    emit('awake', 'Code-a', 2000)
    expect(result.current.map(e => e.state)).toEqual(['awake', 'waking'])
    expect(result.current[0].bead_id).toBe('Code-a')
  })

  it('caps the ring at `cap`, dropping the oldest', () => {
    const { result } = renderHook(() => useConductorFeed(3))
    for (let i = 0; i < 6; i++) emit('awake', `Code-${i}`, 1000 + i)
    expect(result.current).toHaveLength(3)
    // Newest first: the last three emitted (5,4,3).
    expect(result.current.map(e => e.bead_id)).toEqual(['Code-5', 'Code-4', 'Code-3'])
  })

  it('assigns stable, monotonic seq keys even when ts collides', () => {
    const { result } = renderHook(() => useConductorFeed())
    emit('awake', 'Code-a', 5000)
    emit('awake', 'Code-b', 5000) // same ts
    const seqs = result.current.map(e => e.seq)
    expect(new Set(seqs).size).toBe(2)
    expect(seqs[0]).toBeGreaterThan(seqs[1])
  })

  it('falls back to receipt time when last_pulse_ms is null', () => {
    const { result } = renderHook(() => useConductorFeed())
    emit('idle', null, null)
    expect(result.current[0].ts).toBeGreaterThan(0)
  })
})
