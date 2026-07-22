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

import { Component, useSyncExternalStore, type ReactNode } from 'react'

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

/** Auto-dismiss window (ms) unless the toast is hovered. */
const AUTO_DISMISS_MS = 8000

export function dismissToast(id: number) {
  toasts = toasts.filter(t => t.id !== id)
  emit()
}

/** Push a toast. Returns its id. Exposed for tests + the error boundary. */
export function pushInvokeToast(message: string, detail: string): number {
  const id = ++counter
  // Guard against Date being stubbed oddly; fall back to empty ts.
  let timestamp = ''
  try {
    timestamp = new Date().toLocaleTimeString()
  } catch {
    timestamp = ''
  }
  toasts = [...toasts, { id, message, detail, timestamp }]
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
  // Hover pauses auto-dismiss: we arm the timer on mount and clear it on
  // hover-enter, re-arm on hover-leave. Simpler than tracking elapsed time.
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = () => {
    timer = setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS)
  }
  const disarm = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  return (
    <div
      className="bs-invoke-toast"
      ref={el => {
        // ref callback runs on mount (el != null) and unmount (el == null).
        if (el) arm()
        else disarm()
      }}
      onMouseEnter={disarm}
      onMouseLeave={arm}
    >
      <div className="bs-invoke-toast-msg" title={toast.detail}>
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
