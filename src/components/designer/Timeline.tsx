import { useMemo } from 'react'
import { ProviderMark } from '../ProviderMark'
import { buildActivity, type ActivityEntry, type SessionNode } from './activity'
import { StatusDot } from './LiveSessions'
import { useSessionTree } from './useSessionTree'
import { requestHistoryFocus } from './transcripts'
import { openDesignerView } from '../../state/designerNav'
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

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function SessionRow({ node, projectId, nested }: { node: SessionNode; projectId: string; nested?: boolean }) {
  const { summary } = node
  const open = () => { if (!summary.parentId) { requestHistoryFocus(projectId, summary); openDesignerView('history') } }
  return (
    <div style={{ ...styles.row, marginLeft: nested ? 22 : 0 }} data-testid="timeline-session">
      <span style={{ ...styles.tick, background: 'var(--bs-blue)' }} />
      <span style={styles.time}>{timeOf(summary.modifiedMs)}</span>
      <span style={styles.mark}><ProviderMark id={summary.provider} size={13} /></span>
      <StatusDot status={node.status} />
      <button style={styles.sessionTitle} onClick={open} disabled={Boolean(summary.parentId)} title={summary.parentId ? 'Subagent' : 'Open in History'}>{summary.title}</button>
      {summary.agentType && <span style={styles.chip}>{summary.agentType}</span>}
      {node.beads.map(id => <span key={id} style={styles.beadLink}>{id}</span>)}
      {node.duration && <span style={styles.time}>{node.duration}</span>}
    </div>
  )
}

function EntryRow({ entry, projectId }: { entry: ActivityEntry; projectId: string }) {
  if (entry.kind === 'bead') {
    return (
      <div style={styles.row}>
        <span style={styles.tick} />
        <span style={styles.time}>{timeOf(entry.at)}</span>
        <span style={styles.rowId}>{entry.issue.id}</span>
        <span style={styles.rowTitle}>{entry.issue.title}</span>
      </div>
    )
  }
  return <>
    <SessionRow node={entry.node} projectId={projectId} />
    {entry.node.children.map(child => <SessionRow key={child.summary.id} node={child} projectId={projectId} nested />)}
  </>
}

function TimelineInner({ repoPath, projectId }: { repoPath: string; projectId: string }) {
  const snap = useBdSnapshot(repoPath)
  const beadIds = useMemo(() => snap.all.map(issue => issue.id), [snap.all])
  const { tree } = useSessionTree(repoPath, beadIds)
  const days = useMemo(() => buildActivity(snap.all, tree), [snap.all, tree])

  if (!snap.loaded) {
    return <div style={styles.hint}>Reading the timeline…</div>
  }
  if (snap.error) {
    return <div style={styles.hint}>bd error: {snap.error}</div>
  }
  const closedCount = snap.all.filter(i => i.status === 'closed' && i.closed_at).length

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <p style={styles.title}>Timeline</p>
        <p style={styles.sub}>Closed beads and Claude, Codex and Qwen sessions, most recent first.</p>
        {closedCount === 0 && <p style={styles.sub}>No closed beads yet. Ship one and it lands here.</p>}
      </div>

      <div style={styles.lanes}>
        {days.map(day => (
          <section key={day.key} style={styles.lane}>
            <div style={styles.dayHead}>
              <span style={styles.dayLabel}>{day.label}</span>
              <span style={styles.dayCount}>{day.entries.length}</span>
            </div>
            <div style={styles.rail}>
              {day.entries.map(entry => <EntryRow key={entry.key} entry={entry} projectId={projectId} />)}
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
      <TimelineInner repoPath={active.path} projectId={active.id} />
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
  mark: { display: 'inline-flex', color: 'var(--bs-fg-muted)', flexShrink: 0 },
  sessionTitle: { border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontSize: 13, color: 'var(--bs-fg)', textAlign: 'left', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  chip: { fontSize: 10, padding: '0 6px', borderRadius: 5, border: '1px solid var(--bs-border)', color: 'var(--bs-fg-muted)', flexShrink: 0 },
  beadLink: { fontSize: 10, fontFamily: 'var(--du-font-mono)', fontWeight: 600, color: 'var(--bs-green)', flexShrink: 0 },
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
