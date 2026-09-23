import { useSyncExternalStore, useState } from 'react'
import { cancelDestructiveAction, getPendingDestructiveAction, resolveDestructiveAction, subscribeDestructiveAction } from '../state/destructiveActions'

export function DestructiveActionGuard() {
  const request = useSyncExternalStore(subscribeDestructiveAction, getPendingDestructiveAction, getPendingDestructiveAction)
  const [dontAskAgain, setDontAskAgain] = useState(false)
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
        <button autoFocus type="button" className="bs-modal-btn bs-modal-btn--ghost" onClick={cancelDestructiveAction}>Cancel</button>
        <button type="button" className="bs-modal-btn bs-modal-btn--primary" onClick={() => resolveDestructiveAction(true, dontAskAgain)}>Continue</button>
      </div>
    </div>
  </div>
}
