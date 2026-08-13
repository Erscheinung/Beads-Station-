// Code-9ud — single live subscription to the backend's `conductor_status`
// event, shared by ConductorControl (the right-panel card) and the
// DesignerShell footer so there is ONE listener and ONE source of truth.
//
// Self-contained safeListen + AbortController, mirroring GateCockpit — the
// DesignerShell mounts outside App's BdLiveProvider, and the conductor status
// isn't part of the bd snapshot anyway (it's an app-global event, not an issue).

import { useEffect, useState } from 'react'
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
