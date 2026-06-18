// Phase 6 — Morning-confirmation modal.
//
// Shown by App.tsx the first time a project is opened on a given local-tz
// calendar date. The check is:
//
//   localStorage.getItem('beads-station.lastConfirmed.' + projectId) !== todayYMD()
//
// On Resume (default / Enter / Escape): keeps the existing claudeSessionId,
// records today's YMD, and lets ClaudeChat mount.
// On New session: rolls a fresh UUID via projects_set_claude_session, then
// records today's YMD and lets ClaudeChat mount.
//
// The modal is rendered to a portal at document.body so it sits above the
// app-grid stacking context. Backdrop has rgba(0,0,0,0.45) — opaque enough
// to read as modal, transparent enough that the user can confirm what
// project they're confirming for via the dimmed sidebar.

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface MorningConfirmProps {
  projectId: string
  sessionId: string
  onResume: () => void
  onNew: () => void
}

export function MorningConfirm({ projectId, sessionId, onResume, onNew }: MorningConfirmProps) {
  const resumeRef = useRef<HTMLButtonElement | null>(null)
  const newRef = useRef<HTMLButtonElement | null>(null)

  // Autofocus the primary button on mount so Enter activates Resume.
  useEffect(() => {
    resumeRef.current?.focus()
  }, [])

  // Global keydown — Escape and Enter both pick Resume. Tab cycles the two
  // buttons. The modal is the only focusable surface while mounted; the
  // dim backdrop is non-interactive (no clickthrough on the body).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        onResume()
        return
      }
      if (ev.key === 'Enter') {
        // Only when neither button explicitly has focus (otherwise the
        // button's own onClick fires; we don't want to double-fire).
        const a = document.activeElement
        if (a !== resumeRef.current && a !== newRef.current) {
          ev.preventDefault()
          onResume()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onResume])

  const node = (
    <div
      className="bs-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bs-morning-title"
      onClick={ev => {
        // Click on the backdrop = Resume (safe default). Stop propagation
        // from the card itself so an inside-click doesn't dismiss.
        if (ev.target === ev.currentTarget) onResume()
      }}
    >
      <div className="bs-modal-card">
        <h2 className="bs-modal-title" id="bs-morning-title">Resume Claude session?</h2>
        <p className="bs-modal-sub">
          {projectId} · {sessionId || '(no session id)'}
        </p>
        <div className="bs-modal-actions">
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

// Helper exported for App.tsx to keep the today-YMD logic in one place.
export function todayYMD(): string {
  const d = new Date()
  // Local-tz YYYY-MM-DD. Avoid toISOString() which is UTC; we want the
  // user's wall-clock day.
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const STORAGE_PREFIX = 'beads-station.lastConfirmed.'

export function shouldConfirm(projectId: string): boolean {
  try {
    return localStorage.getItem(STORAGE_PREFIX + projectId) !== todayYMD()
  } catch {
    return true
  }
}

export function recordConfirmation(projectId: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + projectId, todayYMD())
  } catch {
    /* noop */
  }
}
