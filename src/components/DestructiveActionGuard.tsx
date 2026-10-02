import { useEffect, useRef, useSyncExternalStore, useState } from 'react'
import { cancelDestructiveAction, getPendingDestructiveAction, resolveDestructiveAction, subscribeDestructiveAction } from '../state/destructiveActions'

export function DestructiveActionGuard() {
  const request = useSyncExternalStore(subscribeDestructiveAction, getPendingDestructiveAction, getPendingDestructiveAction)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const dontAskAgainRef = useRef(dontAskAgain)
  dontAskAgainRef.current = dontAskAgain
  const requestId = request?.id

  // Enter confirms and Escape cancels from anywhere in the dialog, so a
  // keyboard-started close never needs the mouse. A focused Cancel button or
  // checkbox keeps its own Enter/Space behavior.
  useEffect(() => {
    if (requestId === undefined) return
    setDontAskAgain(false)
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancelDestructiveAction()
        return
      }
      if (event.key !== 'Enter') return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('[data-dialog-cancel]')) return
      event.preventDefault()
      event.stopPropagation()
      resolveDestructiveAction(true, dontAskAgainRef.current)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [requestId])

  if (!request) return null

  return <div className="bs-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="bs-destructive-title">
    <div className="bs-modal-card">
      <h2 className="bs-modal-title" id="bs-destructive-title">{request.title}</h2>
      <p className="bs-modal-sub">{request.detail}</p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0', color: 'var(--bs-fg-muted)', fontSize: 12 }}>
        <input type="checkbox" checked={dontAskAgain} onChange={event => setDontAskAgain(event.target.checked)} />
        Don’t ask again for destructive actions
      </label>
      <div className="bs-modal-actions">
        <button data-dialog-cancel type="button" className="bs-modal-btn bs-modal-btn--ghost" onClick={cancelDestructiveAction}>Cancel <kbd aria-hidden>Esc</kbd></button>
        <button autoFocus type="button" className="bs-modal-btn bs-modal-btn--primary" onClick={() => resolveDestructiveAction(true, dontAskAgain)}>Continue <kbd aria-hidden>↵</kbd></button>
      </div>
    </div>
  </div>
}
