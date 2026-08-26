import { useCallback, useEffect, useState } from 'react'
import { safeListen } from '../../lib/safeListen'
import { useProjects } from '../../state/projects'
import { gateList, gateResolve, type Gate } from '../../lib/gateBridge'
import { bdNote } from '../../types/issue'

// RV5.0 (Code-ew0) — the cockpit gate view. Lists open bd HUMAN gates and lets
// the operator resolve them: Approve = `bd gate resolve <id>` (closes the gate,
// its blocked molecule step proceeds); Reject = note the gate + leave it open
// (the step stays blocked = "not approved"). This is the Designer-UI
// "NEXT UP · auto-picked" + approve/reject.
//
// Self-contained live refresh: an initial fetch + a `bd_changed:<repo>` listen
// (via safeListen + AbortController) so it updates when a molecule pours a gate
// or the conductor advances a step. Deliberately does NOT use BdLiveProvider —
// DesignerShell mounts outside App's provider, and gates aren't in the bd
// snapshot anyway (they're issue_type=gate, filtered out of useBdSnapshot).

export function GateCockpit() {
  const { projects, activeId } = useProjects()
  const repoPath = projects.find(p => p.id === activeId)?.path ?? ''

  const [gates, setGates] = useState<Gate[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!repoPath) return
    try {
      const g = await gateList(repoPath)
      setGates(g)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoaded(true)
    }
  }, [repoPath])

  useEffect(() => {
    if (!repoPath) return
    // Reset transient state so a stale error / button-lock from the previous
    // project doesn't bleed into this one when the active repo switches
    // mid-request (the in-flight call resolves against the old path harmlessly;
    // this refetch re-derives the new repo's gates).
    setError(null)
    setBusyId(null)
    const ctrl = new AbortController()
    void refresh()
    // Re-fetch on any bd change for this repo (gate poured / step advanced).
    void safeListen(`bd_changed:${repoPath}`, () => void refresh(), ctrl.signal)
    return () => ctrl.abort()
  }, [repoPath, refresh])

  const onApprove = useCallback(
    async (id: string) => {
      setBusyId(id)
      setError(null)
      try {
        await gateResolve(repoPath, id)
        await refresh()
      } catch (e) {
        setError(String(e))
      } finally {
        setBusyId(null)
      }
    },
    [repoPath, refresh],
  )

  const onReject = useCallback(
    async (id: string) => {
      setBusyId(id)
      setError(null)
      try {
        // Reject = record a decline note; the gate stays OPEN so the step stays
        // blocked (the honest "not approved" state). We do not force-close.
        await bdNote(repoPath, id, 'Rejected at cockpit gate — step stays blocked pending changes.')
        await refresh()
      } catch (e) {
        setError(String(e))
      } finally {
        setBusyId(null)
      }
    },
    [repoPath, refresh],
  )

  return (
    <div style={styles.wrap} data-testid="gate-cockpit">
      <p style={styles.label}>NEXT UP · GATES</p>

      {!repoPath && <p style={styles.empty}>No project selected.</p>}

      {repoPath && !loaded && <p style={styles.empty}>Loading gates…</p>}

      {repoPath && loaded && gates.length === 0 && (
        <p style={styles.empty}>No gates awaiting approval.</p>
      )}

      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.list}>
        {gates.map(g => (
          <div key={g.id} style={styles.card}>
            <p style={styles.gateTitle}>{g.title}</p>
            <p style={styles.gateId}>{g.id}</p>
            {g.description && <p style={styles.gateDesc}>{g.description}</p>}
            <div style={styles.actions}>
              <button
                style={{ ...styles.btn, ...styles.approve, ...(busyId === g.id ? styles.btnBusy : {}) }}
                disabled={busyId === g.id}
                onClick={() => void onApprove(g.id)}
              >
                Approve
              </button>
              <button
                style={{ ...styles.btn, ...styles.reject, ...(busyId === g.id ? styles.btnBusy : {}) }}
                disabled={busyId === g.id}
                onClick={() => void onReject(g.id)}
              >
                Reject
              </button>
            </div>
          </div>
        ))}
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
  empty: {
    margin: 0,
    fontSize: 12,
    color: 'var(--bs-fg-muted)',
  },
  error: {
    margin: 0,
    fontSize: 11,
    color: 'var(--bs-red)',
    wordBreak: 'break-word',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  card: {
    padding: 12,
    background: 'var(--bs-bg-dark)',
    border: '1px solid var(--bs-border)',
    borderRadius: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  gateTitle: {
    margin: 0,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--bs-fg)',
  },
  gateId: {
    margin: 0,
    fontSize: 10,
    fontFamily: 'var(--du-font-mono)',
    color: 'var(--bs-fg-faint)',
  },
  gateDesc: {
    margin: '2px 0 0',
    fontSize: 11,
    color: 'var(--bs-fg-muted)',
    lineHeight: 1.45,
  },
  actions: {
    display: 'flex',
    gap: 8,
    marginTop: 6,
  },
  btn: {
    flex: 1,
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
  approve: {
    borderColor: 'var(--bs-green)',
    color: 'var(--bs-green)',
  },
  reject: {
    borderColor: 'var(--bs-red)',
    color: 'var(--bs-red)',
  },
  btnBusy: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
}
