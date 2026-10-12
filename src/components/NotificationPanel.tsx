import { useEffect, useState } from 'react'
import { clearAllPaneNotifications, clearPaneNotification, showPane, usePaneNotifications, type PaneNotification } from '../state/paneNotifications'
import { closeNotificationPanel, useNotificationPanelOpen } from '../state/notificationPanel'
import { locatePane, paneTabNumber } from '../state/termPanes'
import { useProjects } from '../state/projects'

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`
}

/** Every pane that is waiting, newest first, with a jump and a dismiss each. */
export function NotificationPanel() {
  const open = useNotificationPanelOpen()
  const notifications = usePaneNotifications()
  const { projects } = useProjects()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeNotificationPanel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => { clearInterval(timer); window.removeEventListener('keydown', onKey, true) }
  }, [open])

  if (!open) return null
  const rows = [...notifications.values()].sort((a, b) => b.at - a.at)
  const where = (notification: PaneNotification) => {
    const location = locatePane(notification.paneId)
    if (!location) return 'Closed pane'
    const workspace = projects.find(project => project.id === location.projectId)?.name ?? location.projectId
    const tab = paneTabNumber(notification.paneId)
    return `${workspace} · ${location.agentBridgeId ? 'agent' : 'terminal'}${tab ? ` · tab ${tab}` : ''}`
  }

  return <div className="bs-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeNotificationPanel() }}>
    <div className="bs-modal-card bs-notification-panel" role="dialog" aria-modal="true" aria-labelledby="bs-notification-panel-title">
      <h2 className="bs-modal-title" id="bs-notification-panel-title">Waiting panes</h2>
      {rows.length === 0
        ? <p className="bs-modal-sub" style={{ fontFamily: 'inherit' }}>Nothing is waiting for you.</p>
        : <ul className="bs-notification-panel__list">
          {rows.map((notification, index) => <li key={notification.paneId}>
            <button autoFocus={index === 0} className="bs-notification-panel__jump" onClick={() => { showPane(notification.paneId); closeNotificationPanel() }}>
              <span className="bs-notification-panel__where">{where(notification)}</span>
              <span className="bs-notification-panel__message">{notification.message}</span>
              <span className="bs-notification-panel__time">{ago(notification.at, now)}</span>
            </button>
            <button aria-label={`Dismiss notification from ${where(notification)}`} onClick={() => clearPaneNotification(notification.paneId)}>Dismiss</button>
          </li>)}
        </ul>}
      <div className="bs-modal-actions" style={{ marginTop: 12 }}>
        <button type="button" className="bs-modal-btn bs-modal-btn--ghost" disabled={rows.length === 0} onClick={clearAllPaneNotifications}>Clear all</button>
        <button type="button" className="bs-modal-btn bs-modal-btn--ghost" onClick={closeNotificationPanel}>Close <kbd aria-hidden>Esc</kbd></button>
      </div>
    </div>
  </div>
}
