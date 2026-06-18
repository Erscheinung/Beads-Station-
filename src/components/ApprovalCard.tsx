// Phase 6 — Inline approval card for permission_request frames.
//
// Rendered IN PLACE inside the chat scroll (not as a modal). Pending state
// shows the tool name + a <pre> with the JSON input + Approve/Deny buttons.
// Once handled, collapses to a single line — `[ok] approved tool=Edit`
// or `[x] denied tool=Edit`. NO checkmark / cross emoji glyphs (audit-emoji
// rejects U+2713 / U+2717).
//
// Buttons fire `claude_approve` / `claude_deny` Tauri commands (Worker 1
// owns those). Failures are surfaced as inline error text but do not crash
// the parent transcript.

import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

export type ApprovalStatus = 'pending' | 'approved' | 'denied'

interface ApprovalCardProps {
  projectId: string
  requestId: string
  toolName: string
  input: unknown
  status: ApprovalStatus
  onResolve?: (next: 'approved' | 'denied') => void
}

export function ApprovalCard({
  projectId,
  requestId,
  toolName,
  input,
  status,
  onResolve,
}: ApprovalCardProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (status === 'approved') {
    return (
      <div className="bs-approval bs-approval--resolved" style={{ color: 'var(--bs-fg-faint)' }}>
        [ok] approved tool={toolName}
      </div>
    )
  }
  if (status === 'denied') {
    return (
      <div className="bs-approval bs-approval--resolved" style={{ color: 'var(--bs-fg-faint)' }}>
        [x] denied tool={toolName}
      </div>
    )
  }

  const inputJson = (() => {
    try {
      return JSON.stringify(input ?? null, null, 2)
    } catch {
      return String(input)
    }
  })()

  const act = async (kind: 'approve' | 'deny') => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await invoke(kind === 'approve' ? 'claude_approve' : 'claude_deny', {
        projectId,
        requestId,
      })
      onResolve?.(kind === 'approve' ? 'approved' : 'denied')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bs-approval" data-request-id={requestId}>
      <div className="bs-approval-tool">tool: {toolName}</div>
      <pre className="bs-approval-input">{inputJson}</pre>
      <div className="bs-approval-actions">
        <button
          type="button"
          className="bs-approval-btn bs-approval-btn--approve"
          disabled={busy}
          onClick={() => act('approve')}
        >
          Approve (a)
        </button>
        <button
          type="button"
          className="bs-approval-btn bs-approval-btn--deny"
          disabled={busy}
          onClick={() => act('deny')}
        >
          Deny (d)
        </button>
      </div>
      {error && (
        <div style={{ color: 'var(--bs-red)', fontSize: 11, marginTop: 4 }}>
          [error] {error}
        </div>
      )}
    </div>
  )
}
