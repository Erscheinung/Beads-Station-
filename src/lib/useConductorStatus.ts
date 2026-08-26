// Code-9ud — single live subscription to the backend's `conductor_status`
// event, shared by ConductorControl (the right-panel card) and the
// DesignerShell footer so there is ONE listener and ONE source of truth.
//
// Self-contained safeListen + AbortController, mirroring GateCockpit — the
// DesignerShell mounts outside App's BdLiveProvider, and the conductor status
// isn't part of the bd snapshot anyway (it's an app-global event, not an issue).

import { useEffect, useRef, useState } from 'react'
import { safeListen } from './safeListen'
import { CONDUCTOR_STATUS_EVENT, type ConductorStatus } from './conductorBridge'

/**
 * Subscribe to the conductor's live status. Returns the latest ConductorStatus,
 * or `null` before the first event arrives (i.e. the conductor was never
 * started this session). One listener per mounting component; both callers here
 * are singletons in the shell, so the total listener count stays at two.
 */
export function useConductorStatus(): ConductorStatus | null {
  const [status, setStatus] = useState<ConductorStatus | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    void safeListen<ConductorStatus>(
      CONDUCTOR_STATUS_EVENT,
      e => setStatus(e.payload),
      ctrl.signal,
    )
    return () => ctrl.abort()
  }, [])

  return status
}

// Code-jx3.1 (RV6.1) — the live per-pulse feed. Where useConductorStatus REPLACES
// on each event (one snapshot for the card/footer), this ACCUMULATES into a capped
// ring so the DU3 panel can show a scrolling history: waking -> awake -> closed,
// each with a bead id + timestamp. Read-only; additive to useConductorStatus (they
// each register one listener — ActiveAgents mounts this hook exactly once).

/** One entry in the conductor feed, newest first. */
export interface ConductorFeedEntry {
  /** Monotonic within a session so React keys stay stable when two pulses share a ts. */
  seq: number
  state: string
  bead_id: string | null
  detail: string | null
  /** Epoch-ms of the pulse (falls back to receipt time if the backend omits it). */
  ts: number
}

const DEFAULT_FEED_CAP = 50

/**
 * Accumulate `conductor_status` events into a capped, newest-first ring buffer
 * (FE-only). `cap` bounds memory; excess entries drop off the tail. One listener
 * per mounting component.
 */
export function useConductorFeed(cap: number = DEFAULT_FEED_CAP): ConductorFeedEntry[] {
  const [feed, setFeed] = useState<ConductorFeedEntry[]>([])
  const seqRef = useRef(0)

  useEffect(() => {
    const ctrl = new AbortController()
    void safeListen<ConductorStatus>(
      CONDUCTOR_STATUS_EVENT,
      e => {
        const s = e.payload
        seqRef.current += 1
        const entry: ConductorFeedEntry = {
          seq: seqRef.current,
          state: s.state,
          bead_id: s.bead_id,
          detail: s.detail,
          ts: s.last_pulse_ms ?? Date.now(),
        }
        setFeed(prev => [entry, ...prev].slice(0, cap))
      },
      ctrl.signal,
    )
    return () => ctrl.abort()
  }, [cap])

  return feed
}

/** Presentation mapping shared by the footer + card. `null` = never started. */
export function statusPresentation(status: ConductorStatus | null): {
  dot: string
  text: string
} {
  const state = status?.state ?? 'stopped'
  switch (state) {
    case 'awake':
    case 'waking':
      return {
        dot: 'var(--bs-green)',
        text: status?.bead_id
          ? `Conductor awake · ${status.bead_id}`
          : 'Conductor awake',
      }
    case 'idle':
      return { dot: 'var(--bs-fg-faint)', text: 'Conductor idle' }
    case 'deferred':
      return { dot: 'var(--bs-orange)', text: 'Conductor deferred' }
    case 'error':
      return { dot: 'var(--bs-red)', text: 'Conductor error' }
    case 'stopped':
    default:
      return { dot: 'var(--bs-fg-faint)', text: 'Conductor stopped' }
  }
}
