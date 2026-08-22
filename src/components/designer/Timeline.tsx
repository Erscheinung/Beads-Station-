import { useMemo } from 'react'
import type { Issue } from '../../types/issue'
import { BdLiveProvider } from '../../lib/BdLiveProvider'
import { useBdSnapshot } from '../../lib/bdCache'
import { useProjects } from '../../state/projects'

// DU4 (Code-kp4) — the Timeline view. Closed beads over time, grouped into
// day lanes (most recent first). Source: the shared bd snapshot's `all`
// filtered to status=closed with a `closed_at` timestamp — same engine + same
// data as the terminal build, just a calmer skin.
//
// Mounted into DesignerShell's center column when nav === 'timeline'. Supplies
// its own BdLiveProvider (shell renders outside App's provider), mirroring
// BeadGraph + ActiveAgents.

interface DayGroup {
  /** YYYY-MM-DD key. */
  key: string
  /** "Fri, Aug 22" heading. */
  label: string
  issues: Issue[]
}

const DAY_FMT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Group closed issues into day lanes, newest day first, newest issue first. */
function groupByDay(all: Issue[]): DayGroup[] {
  const closed = all
    .filter(i => i.status === 'closed' && i.closed_at)
    .sort((a, b) => (a.closed_at! < b.closed_at! ? 1 : -1))

  const groups = new Map<string, DayGroup>()
  for (const issue of closed) {
    const d = new Date(issue.closed_at!)
    // Local-day key (not UTC) so a late-evening close lands on the right lane.
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    let g = groups.get(key)
    if (!g) {
      g = { key, label: d.toLocaleDateString(undefined, DAY_FMT), issues: [] }
      groups.set(key, g)
    }
    g.issues.push(issue)
  }
  return [...groups.values()]
}

function TimelineInner({ repoPath }: { repoPath: string }) {
  const snap = useBdSnapshot(repoPath)
  const days = useMemo(() => groupByDay(snap.all), [snap.all])

  if (!snap.loaded) {
    return <div style={styles.hint}>Reading the timeline…</div>
  }
  if (days.length === 0) {
    return <div style={styles.hint}>No closed beads yet. Ship one and it lands here.</div>
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <p style={styles.title}>Timeline</p>
        <p style={styles.sub}>Closed beads, most recent first.</p>
      </div>

      <div style={styles.lanes}>
        {days.map(day => (
          <section key={day.key} style={styles.lane}>
            <div style={styles.dayHead}>
              <span style={styles.dayLabel}>{day.label}</span>
              <span style={styles.dayCount}>{day.issues.length}</span>
            </div>
            <div style={styles.rail}>
              {day.issues.map(issue => (
                <div key={issue.id} style={styles.row}>
                  <span style={styles.tick} />
                  <span style={styles.time}>{timeOf(issue.closed_at!)}</span>
                  <span style={styles.rowId}>{issue.id}</span>
                  <span style={styles.rowTitle}>{issue.title}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

export function Timeline() {
  const { projects, activeId } = useProjects()
  const active = projects.find(p => p.id === activeId) ?? projects[0] ?? null

  if (!active) return <div style={styles.hint}>No project selected.</div>

  return (
    <BdLiveProvider>
      <TimelineInner repoPath={active.path} />
    </BdLiveProvider>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    overflow: 'auto',
  },
  hint: {
    padding: 40,
    textAlign: 'center',
    color: 'var(--bs-fg-muted)',
    fontSize: 13,
  },
  header: {
    padding: '16px 24px',
    borderBottom: '1px solid var(--bs-border)',
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--bs-fg)',
  },
  sub: {
    margin: '2px 0 0',
    fontSize: 12,
    color: 'var(--bs-fg-muted)',
  },
  lanes: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
    padding: '20px 24px',
  },
  lane: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  dayHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  dayLabel: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.02em',
    color: 'var(--bs-fg)',
  },
  dayCount: {
    fontSize: 10,
    fontFamily: 'var(--du-font-mono)',
    color: 'var(--bs-fg-faint)',
    border: '1px solid var(--bs-border)',
    borderRadius: 5,
    padding: '0 6px',
  },
  rail: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    borderLeft: '2px solid var(--bs-border)',
    paddingLeft: 14,
    marginLeft: 3,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 8px',
    borderRadius: 8,
    position: 'relative',
  },
  tick: {
    position: 'absolute',
    left: -21,
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--bs-green)',
    border: '2px solid var(--bs-bg)',
  },
  time: {
    fontSize: 10,
    fontFamily: 'var(--du-font-mono)',
    color: 'var(--bs-fg-faint)',
    minWidth: 44,
  },
  rowId: {
    fontSize: 11,
    fontFamily: 'var(--du-font-mono)',
    fontWeight: 600,
    color: 'var(--bs-green)',
    minWidth: 64,
  },
  rowTitle: {
    fontSize: 13,
    color: 'var(--bs-fg)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
}
