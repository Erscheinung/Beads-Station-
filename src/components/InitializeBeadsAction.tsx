import { useState } from 'react'
import { beadsInitErrorMessage, initializeBeads } from '../lib/beadsInit'

interface InitializeBeadsActionProps {
  repoPath: string
  compact?: boolean
}

/** Shared no-database action for Board and Explorer. It is intentionally
 * explicit: showing the canonical target and effects is part of the action,
 * and ordinary terminal use remains available if it fails. */
export function InitializeBeadsAction({ repoPath, compact = false }: InitializeBeadsActionProps) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState(false)

  const initialize = async () => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    setError(false)
    try {
      const report = await initializeBeads(repoPath)
      setMessage(report.outcome === 'already_exists'
        ? 'Beads is already initialized here; nothing changed.'
        : `${report.outcome === 'bootstrapped' ? 'Beads export bootstrapped' : 'Beads initialized'} and verified. Refreshing…`)
    } catch (reason) {
      setError(true)
      setMessage(beadsInitErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label="Initialize Beads"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: compact ? '10px 12px' : 16,
        margin: compact ? '8px 0' : 8,
        border: '1px solid var(--bs-border)',
        borderRadius: 4,
        background: 'var(--bs-bg-elev)',
        color: 'var(--bs-fg-muted)',
        fontSize: 11,
      }}
    >
      <strong style={{ color: 'var(--bs-fg)' }}>Initialize Beads in this workspace?</strong>
      <span>This creates or bootstraps the local Beads store at <code>{repoPath}</code>. Existing stores are never overwritten.</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" disabled={busy} onClick={() => { void initialize() }}>
          {busy ? 'Initializing…' : 'Initialize Beads'}
        </button>
        {message && <span role={error ? 'alert' : 'status'} style={{ color: error ? 'var(--bs-red)' : 'var(--bs-fg-muted)' }}>{message}</span>}
      </div>
    </section>
  )
}
