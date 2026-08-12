import { useCallback, useEffect, useState } from 'react'
import { safeListen } from '../../lib/safeListen'
import { useProjects } from '../../state/projects'
import {
  senseList,
  sensePromote,
  senseDismiss,
  senseScan,
  senseWatchStart,
  senseWatchStop,
  type Wisp,
} from '../../lib/senseBridge'

// RV5.1 (Code-qqa) — the Sensors panel. Watches the Obsidian vault folders
// (Implementation Prompts/, Daily/); a new `.md` file is minted as an ephemeral
// bd wisp (`bd create --ephemeral`) and surfaced here. Promote = `bd promote`
// (copy into the permanent issues table, preserving id + links); Dismiss =
// `bd close` (the wisp then TTL-collapses, never becomes a permanent bead).
//
// Live: on mount we scan once, list, and start the sensor watcher, then re-run
// scan+list on every `sense_changed` (a static event — sensors are global, not
// per-repo, so unlike GateCockpit the listener key is not the repo path). The
// scan itself is idempotent (dedup by `sense:src=` label), so a spurious event
// never double-mints.

export function SensorsPanel() {
  const { projects, activeId } = useProjects()
  const repoPath = projects.find(p => p.id === activeId)?.path ?? ''

  const [wisps, setWisps] = useState<Wisp[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const scanAndList = useCallback(async () => {
    if (!repoPath) return
    try {
      await senseScan(repoPath)
      setWisps(await senseList(repoPath))
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoaded(true)
    }
  }, [repoPath])

  useEffect(() => {
    if (!repoPath) return
    setError(null)
    setBusyId(null)
    const ctrl = new AbortController()
    void scanAndList()
    void senseWatchStart()
    void safeListen('sense_changed', () => void scanAndList(), ctrl.signal)
    return () => {
      ctrl.abort()
      void senseWatchStop()
    }
  }, [repoPath, scanAndList])

  const onPromote = useCallback(
    async (id: string) => {
      setBusyId(id)
      setError(null)
      try {
        await sensePromote(repoPath, id)
        await scanAndList()
      } catch (e) {
        setError(String(e))
      } finally {
        setBusyId(null)
      }
    },
    [repoPath, scanAndList],
  )

  const onDismiss = useCallback(
    async (id: string) => {
      setBusyId(id)
      setError(null)
      try {
        await senseDismiss(repoPath, id)
        await scanAndList()
      } catch (e) {
        setError(String(e))
      } finally {
        setBusyId(null)
      }
    },
    [repoPath, scanAndList],
  )

  return (
    <div style={styles.wrap}>
      <p style={styles.label}>SENSED · WISPS</p>

      {!loaded && <p style={styles.empty}>Sensing…</p>}

      {loaded && wisps.length === 0 && (
        <p style={styles.empty}>No sensed files awaiting a decision.</p>
      )}

      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.list}>
        {wisps.map(w => (
          <div key={w.id} style={styles.card}>
            <p style={styles.wispTitle}>{w.title}</p>
            <p style={styles.wispId}>{w.id}</p>
            {w.source && <p style={styles.wispSource}>{w.source}</p>}
            <div style={styles.actions}>
              <button
                style={{ ...styles.btn, ...styles.promote, ...(busyId === w.id ? styles.btnBusy : {}) }}
                disabled={busyId === w.id}
                onClick={() => void onPromote(w.id)}
              >
                Promote
              </button>
              <button
                style={{ ...styles.btn, ...styles.dismiss, ...(busyId === w.id ? styles.btnBusy : {}) }}
                disabled={busyId === w.id}
                onClick={() => void onDismiss(w.id)}
              >
                Dismiss
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
  wispTitle: {
    margin: 0,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--bs-fg)',
  },
  wispId: {
    margin: 0,
    fontSize: 10,
    fontFamily: 'var(--du-font-mono)',
    color: 'var(--bs-fg-faint)',
  },
  wispSource: {
    margin: '2px 0 0',
    fontSize: 11,
    fontFamily: 'var(--du-font-mono)',
    color: 'var(--bs-fg-muted)',
    wordBreak: 'break-word',
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
  promote: {
    borderColor: 'var(--bs-green)',
    color: 'var(--bs-green)',
  },
  dismiss: {
    borderColor: 'var(--bs-red)',
    color: 'var(--bs-red)',
  },
  btnBusy: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
}
