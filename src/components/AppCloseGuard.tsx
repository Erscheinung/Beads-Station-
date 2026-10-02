import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { safeListen } from '../lib/listenerRegistry'
import { flushTerminalSessionScreens } from '../lib/terminalSessions'
import { flushTermPanePersistence } from '../state/termPanes'
import { markRendererActive, markRendererBoot, markRendererCleanExit } from '../state/rendererLifecycle'
import { setSessionPreferences, useSessionPreferences } from '../state/sessionPreferences'

type CloseSource = 'shortcut-window' | 'shortcut-quit' | 'window' | 'menu-quit' | 'system'
interface CloseRequest { source: CloseSource }
interface CloseScope { ptyCount: number; providerCount: number; runCount: number }

const EMPTY_SCOPE: CloseScope = { ptyCount: 0, providerCount: 0, runCount: 0 }

function sourceLabel(source: CloseSource): string {
  if (source === 'shortcut-window') return 'Cmd/Ctrl+W'
  if (source === 'shortcut-quit') return 'Cmd/Ctrl+Q'
  if (source === 'menu-quit') return 'the application menu'
  if (source === 'window') return 'the window close button'
  return 'the operating system'
}

export function AppCloseGuard() {
  const [request, setRequest] = useState<CloseRequest | null>(null)
  const [scope, setScope] = useState<CloseScope | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const sessionPreferences = useSessionPreferences()
  const requestRef = useRef<CloseRequest | null>(null)
  const priorFocus = useRef<HTMLElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  requestRef.current = request

  useEffect(() => {
    if (markRendererBoot()) {
      // A2 has no durable owner. A surviving backend after a renderer crash is
      // stale app-owned work, so reap it without mounting a pane or provider.
      void invoke('app_recover_stale_sessions').catch(() => {})
    }
  }, [])

  const open = useCallback((next: CloseRequest) => {
    if (requestRef.current) return
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    requestRef.current = next
    setRequest(next)
    setScope(null)
    setError('')
    setDontAskAgain(false)
    void invoke<CloseScope>('app_close_scope').then(value => setScope(value ?? EMPTY_SCOPE)).catch(() => setScope(EMPTY_SCOPE))
  }, [])

  useEffect(() => {
    let disposed = false
    let release: (() => void) | undefined
    void safeListen<CloseRequest>('app:close-requested', event => open(event.payload)).then(unlisten => {
      if (disposed) unlisten(); else release = unlisten
    }).catch(() => {})
    const onBrowserRequest = (event: Event) => open((event as CustomEvent<CloseRequest>).detail)
    window.addEventListener('app:close-requested', onBrowserRequest)
    return () => { disposed = true; release?.(); window.removeEventListener('app:close-requested', onBrowserRequest) }
  }, [open])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key !== 'w' && key !== 'q') return
      event.preventDefault()
      event.stopPropagation()
      const source: CloseSource = key === 'w' ? 'shortcut-window' : 'shortcut-quit'
      open({ source })
      void invoke('app_request_close', { source }).catch(() => {})
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const cancel = useCallback(async () => {
    if (busy) return
    try { await invoke('app_resolve_close', { stopSessions: false }) } catch { /* browser fallback */ }
    requestRef.current = null
    setRequest(null)
    setScope(null)
    setDontAskAgain(false)
    requestAnimationFrame(() => priorFocus.current?.focus())
  }, [busy])

  const stopAndClose = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError('')
    if (dontAskAgain) setSessionPreferences({ confirmDestructiveActions: false })
    // Persist one coherent snapshot before native process ownership is released.
    flushTerminalSessionScreens()
    flushTermPanePersistence()
    markRendererCleanExit()
    try {
      await invoke('app_resolve_close', { stopSessions: true })
    } catch (reason) {
      markRendererActive()
      setError(String(reason))
      setBusy(false)
    }
  }, [busy, dontAskAgain])

  useEffect(() => {
    if (request && !sessionPreferences.confirmDestructiveActions && !busy) void stopAndClose()
  }, [request, sessionPreferences.confirmDestructiveActions, busy, stopAndClose])

  useEffect(() => {
    if (!request) return
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        void cancel()
        return
      }
      // Enter confirms once the affected sessions are known; a focused Cancel
      // button keeps its own Enter behavior.
      if (event.key !== 'Enter' || scope === null) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('[data-dialog-cancel]')) return
      event.preventDefault()
      event.stopPropagation()
      void stopAndClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [request, cancel, scope, stopAndClose])

  // The confirming button is disabled until the scope loads, so autofocus
  // alone would leave the dialog without a focused control.
  useEffect(() => {
    if (request && scope !== null) confirmRef.current?.focus()
  }, [request, scope])

  if (!request) return null
  const current = scope ?? EMPTY_SCOPE
  const affected = current.ptyCount + current.providerCount + current.runCount

  return <div className="bs-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="bs-close-title">
    <div className="bs-modal-card">
      <h2 className="bs-modal-title" id="bs-close-title">Close Beads Station?</h2>
      <p className="bs-modal-sub">Requested from {sourceLabel(request.source)}.</p>
      {scope === null ? <p>Checking app-owned sessions…</p> : affected === 0
        ? <p>No app-owned terminal or provider sessions are active.</p>
        : <p>This stops {current.ptyCount} terminal{current.ptyCount === 1 ? '' : 's'}, {current.providerCount} provider session{current.providerCount === 1 ? '' : 's'}, and {current.runCount} active run{current.runCount === 1 ? '' : 's'} owned by this app.</p>}
      <p>Workspace, pane layout, selected context and bounded screen history are saved. Reopening restores saved context only; it does not preserve a live process or start a model turn.</p>
      {error && <p role="alert">Could not close: {error}</p>}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0', color: 'var(--bs-fg-muted)', fontSize: 12 }}>
        <input type="checkbox" checked={dontAskAgain} onChange={event => setDontAskAgain(event.target.checked)} />
        Don’t ask again for destructive actions
      </label>
      <div className="bs-modal-actions">
        <button data-dialog-cancel type="button" className="bs-modal-btn bs-modal-btn--ghost" disabled={busy} onClick={() => void cancel()}>Cancel <kbd aria-hidden>Esc</kbd></button>
        <button ref={confirmRef} type="button" className="bs-modal-btn bs-modal-btn--primary" disabled={busy || scope === null} onClick={() => void stopAndClose()}>{busy ? 'Stopping…' : <>Close and stop sessions <kbd aria-hidden>↵</kbd></>}</button>
      </div>
    </div>
  </div>
}
