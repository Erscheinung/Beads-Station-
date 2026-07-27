// R3 — invoke error surfacing.
//
// Two exports that together guarantee no failed Tauri `invoke` becomes a
// silent no-op or an uncaught promise rejection:
//
//   safeInvoke<T>(cmd, args, opts?)  — wraps invoke(); on rejection it
//       pushes a bottom-anchored toast (message + timestamp + copy button)
//       and, by default, RESOLVES to `undefined` so callers that only fire-
//       and-forget don't explode. Pass { rethrow: true } to preserve local
//       try/catch handling — the toast still fires, then the error re-throws.
//
//   <InvokeErrorBoundary/>  — a React error boundary mounted at the app root
//       that catches render-phase throws (including a rethrown safeInvoke in
//       an event handler that bubbles to React) and renders a fallback plus a
//       toast, rather than a white screen.
//
// The toast store is a tiny useSyncExternalStore-backed atom so any component
// can subscribe; <InvokeToasts/> renders the live list. This deliberately
// mirrors the existing Board.tsx toast pattern (kind/timeout) but is global.

import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Toast store
// ---------------------------------------------------------------------------

export interface InvokeToast {
  id: number
  /** Short human line shown in the toast body. */
  message: string
  /** Raw error string — copied verbatim by the "copy details" button. */
  detail: string
  /** local-tz HH:MM:SS captured at push time. */
  timestamp: string
  /** RV3.1 — how many identical messages coalesced into this toast. */
  count: number
}

let counter = 0
let toasts: InvokeToast[] = []
const listeners = new Set<() => void>()

function emit() {
  // New array identity so useSyncExternalStore sees a change.
  toasts = toasts.slice()
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getSnapshot(): InvokeToast[] {
  return toasts
}

/** RV3.1 — read-only view of the live toasts (for tests + debugging). */
export function peekToasts(): InvokeToast[] {
  return toasts
}

/** RV3.1 — clear all toasts (test reset + a potential "dismiss all" affordance). */
export function clearToasts(): void {
  toasts = []
  emit()
}

/** Auto-dismiss window (ms) unless the toast is hovered. */
const AUTO_DISMISS_MS = 8000

export function dismissToast(id: number) {
  toasts = toasts.filter(t => t.id !== id)
  emit()
}

/** RV3.1 — hard cap on distinct toasts. Under a fork-exhaustion storm, bd
 *  failures fire faster than the 8s auto-dismiss can drain, so without a cap
 *  they pile up and bury the UI (Esc/i unreachable). Oldest drop first. */
const MAX_TOASTS = 6

/** Push a toast. Returns its id. Exposed for tests + the error boundary.
 *
 * RV3.1 — identical `message`s COALESCE into one toast (count++) instead of
 * stacking N copies, and the total is capped at MAX_TOASTS. This is what stops
 * a bd fork-exhaustion cascade from flooding the screen with hundreds of
 * "invoke bd_list failed" rows and locking the user out of Esc/i. */
export function pushInvokeToast(message: string, detail: string): number {
  // Guard against Date being stubbed oddly; fall back to empty ts.
  let timestamp = ''
  try {
    timestamp = new Date().toLocaleTimeString()
  } catch {
    timestamp = ''
  }

  // Coalesce: if a toast with the same message is already live, bump its count
  // + timestamp (and reuse its id so its dismiss timer re-arms on re-render).
  const existing = toasts.find(t => t.message === message)
  if (existing) {
    toasts = toasts.map(t =>
      t.id === existing.id ? { ...t, count: t.count + 1, timestamp, detail } : t,
    )
    emit()
    return existing.id
  }

  const id = ++counter
  toasts = [...toasts, { id, message, detail, timestamp, count: 1 }]
  // Cap: drop the oldest toasts beyond MAX_TOASTS.
  if (toasts.length > MAX_TOASTS) {
    toasts = toasts.slice(toasts.length - MAX_TOASTS)
  }
  emit()
  return id
}

// ---------------------------------------------------------------------------
// safeInvoke
// ---------------------------------------------------------------------------

export interface SafeInvokeOpts {
  /** Re-throw after surfacing the toast (keeps caller's own try/catch alive). */
  rethrow?: boolean
  /** Override the toast headline; defaults to `invoke <cmd> failed`. */
  label?: string
}

/**
 * Drop-in for `invoke<T>(cmd, args)` that never leaves a failure invisible.
 *
 * On success: resolves to the invoke result.
 * On failure: pushes a toast, then either resolves to `undefined`
 *   (default — safe for fire-and-forget) or re-throws (opts.rethrow).
 */
export async function safeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
  opts: SafeInvokeOpts = {},
): Promise<T | undefined> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return await invoke<T>(cmd, args)
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    const headline = opts.label ?? `invoke ${cmd} failed`
    pushInvokeToast(`${headline}: ${String(err)}`, detail)
    if (opts.rethrow) throw err
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Toast renderer
// ---------------------------------------------------------------------------

function copyDetail(detail: string) {
  try {
    navigator.clipboard?.writeText(detail)
  } catch {
    /* clipboard blocked — no-op; the text is still on screen via title */
  }
}

export function InvokeToasts() {
  const live = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (live.length === 0) return null
  return (
    <div className="bs-invoke-toasts" role="status" aria-live="polite">
      {live.map(t => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  )
}

function ToastCard({ toast }: { toast: InvokeToast }) {
  // RV3.1 — hover pauses auto-dismiss; the timer re-arms whenever the toast's
  // count/timestamp changes (a coalesced repeat) so a toast being actively hit
  // stays up and clears 8s after the LAST hit, not the first. useEffect keyed
  // on count+timestamp handles the re-arm cleanly (the old ref-callback only
  // fired on mount, so coalesced repeats never reset the timer).
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused) return
    const timer = setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast.id, toast.count, toast.timestamp, paused])
  return (
    <div
      className="bs-invoke-toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="bs-invoke-toast-msg" title={toast.detail}>
        {toast.count > 1 && <span className="bs-invoke-toast-count">{toast.count}×</span>}
        {toast.message}
      </div>
      <div className="bs-invoke-toast-foot">
        <span className="bs-invoke-toast-ts">{toast.timestamp}</span>
        <button
          className="bs-invoke-toast-copy"
          onClick={() => copyDetail(toast.detail)}
          type="button"
        >
          copy details
        </button>
        <button
          className="bs-invoke-toast-x"
          onClick={() => dismissToast(toast.id)}
          type="button"
          aria-label="dismiss"
        >
          x
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

interface EBProps {
  children: ReactNode
}
interface EBState {
  error: Error | null
}

/**
 * App-root error boundary. Catches render-phase throws so a bad invoke
 * (rethrown into render) shows a recoverable fallback + toast instead of a
 * blank window. Event-handler rejections are handled by safeInvoke's toast;
 * this covers the render-phase and the rethrow path.
 */
export class InvokeErrorBoundary extends Component<EBProps, EBState> {
  constructor(props: EBProps) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): EBState {
    return { error }
  }

  componentDidCatch(error: Error) {
    pushInvokeToast(
      `render error: ${error.message}`,
      error.stack ?? error.message,
    )
  }

  handleReset = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return (
        <div className="bs-eb-fallback">
          <div className="bs-eb-title">Something broke rendering the UI.</div>
          <div className="bs-eb-detail">{this.state.error.message}</div>
          <button
            className="bs-eb-retry"
            onClick={this.handleReset}
            type="button"
          >
            retry
          </button>
          <InvokeToasts />
        </div>
      )
    }
    return (
      <>
        {this.props.children}
        <InvokeToasts />
      </>
    )
  }
}
