// Code-9ud — single live subscription to the backend's `conductor_status`
// event, shared by ConductorControl (the right-panel card) and the
// DesignerShell footer so there is ONE listener and ONE source of truth.
//
// Self-contained safeListen + AbortController, mirroring GateCockpit — the
// DesignerShell mounts outside App's BdLiveProvider, and the conductor status
// isn't part of the bd snapshot anyway (it's an app-global event, not an issue).

import { useEffect, useRef, useState } from 'react'
import { safeListen } from './safeListen'
import {
  CONDUCTOR_STATUS_EVENT,
  CONDUCTOR_BUILDER_EVENT,
  type ConductorStatus,
  type BuilderStatus,
} from './conductorBridge'

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
  /** RV8.3 — the work model this pulse ran, when the backend reported one. */
  model?: string | null
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
          model: s.model ?? null,
        }
        setFeed(prev => [entry, ...prev].slice(0, cap))
      },
      ctrl.signal,
    )
    return () => ctrl.abort()
  }, [cap])

  return feed
}

// RV8.1 — the per-builder live map. During a fanout the backend pushes one
// BuilderStatus per builder on the SEPARATE `conductor_builder` event as each
// transitions waking -> awake/blocked/error. This hook merges them by bead_id
// into a map the ActiveAgents panel renders as one card per builder. It is
// independent of useConductorStatus (the aggregate footer), so per-builder churn
// never re-renders the footer — one listener, one functional setState per event.

/** How long a terminal-state builder card lingers before it's pruned (ms). */
const BUILDER_TERMINAL_TTL = 4000
/** States that mean the builder is done — pruned after BUILDER_TERMINAL_TTL. */
const BUILDER_TERMINAL = new Set(['awake', 'error'])

/**
 * Subscribe to `conductor_builder` and accumulate the live per-builder map keyed
 * by bead_id. A builder's latest status replaces its prior one; a terminal state
 * (awake/error) schedules that key's removal after a short TTL so finished cards
 * clear on their own. `blocked` persists (the operator still needs to act).
 */
export function useConductorBuilders(): Record<string, BuilderStatus> {
  const [builders, setBuilders] = useState<Record<string, BuilderStatus>>({})
  // Per-key prune timers, so a re-transition (blocked -> awake) cancels a stale one.
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  useEffect(() => {
    const ctrl = new AbortController()
    const pending = timers.current
    void safeListen<BuilderStatus>(
      CONDUCTOR_BUILDER_EVENT,
      e => {
        const b = e.payload
        setBuilders(prev => ({ ...prev, [b.bead_id]: b }))
        // Reset any prior prune timer for this bead; schedule a fresh one only
        // for terminal states.
        if (pending[b.bead_id]) {
          clearTimeout(pending[b.bead_id])
          delete pending[b.bead_id]
        }
        if (BUILDER_TERMINAL.has(b.state)) {
          pending[b.bead_id] = setTimeout(() => {
            delete pending[b.bead_id]
            setBuilders(prev => {
              const next = { ...prev }
              delete next[b.bead_id]
              return next
            })
          }, BUILDER_TERMINAL_TTL)
        }
      },
      ctrl.signal,
    )
    return () => {
      ctrl.abort()
      for (const t of Object.values(pending)) clearTimeout(t)
    }
  }, [])

  return builders
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
    case 'blocked':
      // RV7.3 — a herdr agent is waiting on gate input. Orange (attention, not
      // an error) mirrors the deferred/gate palette.
      return {
        dot: 'var(--bs-orange)',
        text: status?.bead_id
          ? `Conductor blocked · ${status.bead_id} needs input`
          : 'Conductor blocked · needs input',
      }
    case 'deferred':
      return { dot: 'var(--bs-orange)', text: 'Conductor deferred' }
    case 'error':
      return { dot: 'var(--bs-red)', text: 'Conductor error' }
    case 'stopped':
    default:
      return { dot: 'var(--bs-fg-faint)', text: 'Conductor stopped' }
  }
}
