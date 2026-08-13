import { useCallback, useState } from 'react'
import { useProjects } from '../../state/projects'
import { conductorStart, conductorStop } from '../../lib/conductorBridge'
import { useConductorStatus, statusPresentation } from '../../lib/useConductorStatus'

// Code-9ud — the Intelligent Conductor operator surface. Starts/stops the
// tokio-interval scheduler in src-tauri/src/conductor.rs and surfaces its live
// `conductor_status` (via the shared useConductorStatus hook). Start defaults to
// dry_run=true (matches the backend default) so the toggle never fires real
// claude pulses until the operator opts in.
//
// Mirrors the GateCockpit pattern: reads the active repo from useProjects, and
// leans on the shared hook's self-contained safeListen (no BdLiveProvider —
// DesignerShell mounts outside App's provider).

/** Humanize the last-pulse epoch-ms into "Ns ago" / "Nm ago". `null` = never. */
function agoLabel(lastPulseMs: number | null): string | null {
  if (!lastPulseMs) return null
  const secs = Math.max(0, Math.round((Date.now() - lastPulseMs) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  return `${mins}m ago`
}

export function ConductorControl() {
  const { projects, activeId } = useProjects()
  const repoPath = projects.find(p => p.id === activeId)?.path ?? ''

  const status = useConductorStatus()
  const running = status != null && status.state !== 'stopped'

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onToggle = useCallback(async () => {
    if (!repoPath) return
    setBusy(true)
    setError(null)
    try {
      if (running) {
        await conductorStop()
      } else {
        await conductorStart(repoPath)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }, [repoPath, running])

  const pres = statusPresentation(status)
  const ago = agoLabel(status?.last_pulse_ms ?? null)

  return (
    <div style={styles.wrap}>
      <p style={styles.label}>CONDUCTOR</p>

      <div style={styles.card}>
        <div style={styles.stateRow}>
          <span style={{ ...styles.stateDot, background: pres.dot }} />
          <span style={styles.stateText}>{pres.text}</span>
        </div>

        {status?.detail && <p style={styles.detail}>{status.detail}</p>}

        <p style={styles.meta}>
          {status ? `every ${status.interval_secs}s` : 'dry-run · idle'}
          {ago ? ` · last pulse ${ago}` : ''}
        </p>

        {error && <p style={styles.error}>{error}</p>}

        <button
          style={{
            ...styles.btn,
            ...(running ? styles.stop : styles.start),
            ...(busy || !repoPath ? styles.btnBusy : {}),
          }}
          disabled={busy || !repoPath}
          onClick={() => void onToggle()}
        >
          {running ? 'Stop' : 'Start'}
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  label: {
    margin: 0,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.1em',
    color: 'var(--bs-fg-faint)',
  },
  card: {
    padding: 12,
    background: 'var(--bs-bg-dark)',
    border: '1px solid var(--bs-border)',
    borderRadius: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  stateRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  stateDot: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  stateText: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--bs-fg)',
  },
  detail: {
    margin: 0,
    fontSize: 11,
    color: 'var(--bs-fg-muted)',
    lineHeight: 1.45,
  },
  meta: {
    margin: 0,
    fontSize: 10,
    fontFamily: 'var(--du-font-mono)',
    color: 'var(--bs-fg-faint)',
  },
  error: {
    margin: 0,
    fontSize: 11,
    color: 'var(--bs-red)',
    wordBreak: 'break-word',
  },
  btn: {
    marginTop: 2,
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid var(--bs-border)',
    background: 'transparent',
    fontSize: 12,
    fontFamily: 'var(--du-font-sans)',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 100ms ease',
  },
  start: {
    borderColor: 'var(--bs-green)',
    color: 'var(--bs-green)',
  },
  stop: {
    borderColor: 'var(--bs-red)',
    color: 'var(--bs-red)',
  },
  btnBusy: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
}
