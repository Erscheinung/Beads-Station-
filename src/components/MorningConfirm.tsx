// Resume confirmation is shown only after an explicit start request and only
// for a CLI-observed session id. Dismissing it cancels that pending start.

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface MorningConfirmProps {
  projectName: string
  sessionId: string
  onResume: () => void
  onNew: () => void
  onCancel: () => void
}

export function MorningConfirm({ projectName, sessionId, onResume, onNew, onCancel }: MorningConfirmProps) {
  const resumeRef = useRef<HTMLButtonElement | null>(null)
  const newRef = useRef<HTMLButtonElement | null>(null)

  // Resume is the primary explicit action; dismissal never chooses it.
  useEffect(() => {
    resumeRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const node = (
    <div
      className="bs-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bs-morning-title"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onCancel()
      }}
    >
      <div className="bs-modal-card">
        <h2 className="bs-modal-title" id="bs-morning-title">Resume Claude session?</h2>
        <p className="bs-modal-sub">
          {projectName} · {sessionId}
        </p>
        <div className="bs-modal-actions">
          <button type="button" className="bs-modal-btn bs-modal-btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={newRef}
            type="button"
            className="bs-modal-btn bs-modal-btn--ghost"
            onClick={onNew}
          >
            New session
          </button>
          <button
            ref={resumeRef}
            type="button"
            className="bs-modal-btn bs-modal-btn--primary"
            onClick={onResume}
          >
            Resume
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(node, document.body)
}
