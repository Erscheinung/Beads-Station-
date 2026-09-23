import { shouldConfirmDestructiveActions, setSessionPreferences } from './sessionPreferences'

export type DestructiveActionKind = 'pane' | 'workspace'

export interface DestructiveActionRequest {
  kind: DestructiveActionKind
  title: string
  detail: string
  onConfirm: () => void | Promise<void>
}

interface PendingDestructiveAction extends DestructiveActionRequest {
  id: number
}

let nextId = 0
let pending: PendingDestructiveAction | null = null
const listeners = new Set<() => void>()

export function subscribeDestructiveAction(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPendingDestructiveAction(): PendingDestructiveAction | null {
  return pending
}

function emit(): void {
  listeners.forEach(listener => listener())
}

/**
 * Route an app-owned destructive action through one confirmation surface.
 * Actions are immediately allowed after the user disables the preference in
 * Settings or checks "Don't ask again" on the confirmation surface.
 */
export function requestDestructiveAction(request: DestructiveActionRequest): void {
  if (!shouldConfirmDestructiveActions()) {
    void request.onConfirm()
    return
  }
  if (pending) return
  pending = { ...request, id: ++nextId }
  emit()
}

export function resolveDestructiveAction(confirmed: boolean, dontAskAgain: boolean): void {
  const request = pending
  if (!request) return
  pending = null
  if (dontAskAgain) setSessionPreferences({ confirmDestructiveActions: false })
  emit()
  if (confirmed) void request.onConfirm()
}

export function cancelDestructiveAction(): void {
  resolveDestructiveAction(false, false)
}
