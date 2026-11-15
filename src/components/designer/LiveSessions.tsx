// Designer Agents (Code-05b): the Claude/Codex/Qwen sessions running in this
// folder right now, with their subagents nested, and a live tail of the one
// you pick. Nothing is replicated: it reads the agents' own session files (the
// same parser History uses) and draws them with the shared TurnView. Selecting
// a session starts nothing and costs no tokens.

import { useEffect, useRef, useState } from 'react'
import { ProviderMark } from '../ProviderMark'
import { TurnView } from './ConversationView'
import { isLive, type SessionNode, type SessionStatus } from './activity'
import { useSessionTree } from './useSessionTree'
import { readTranscript, relativeTime, requestHistoryFocus, type Transcript } from './transcripts'
import { openDesignerView } from '../../state/designerNav'

const TAIL_MS = 3_000
const TAIL_TURNS = 8

export const STATUS_LABEL: Record<SessionStatus, string> = { running: 'Running', idle: 'Idle', finished: 'Finished' }
export const STATUS_COLOR: Record<SessionStatus, string> = { running: 'var(--bs-blue)', idle: 'var(--bs-yellow)', finished: 'var(--bs-fg-faint)' }

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: STATUS_COLOR[status], boxShadow: status === 'running' ? `0 0 0 3px color-mix(in srgb, ${STATUS_COLOR.running} 25%, transparent)` : undefined }} />
}

export function LiveSessions({ project, beadIds, full }: {
  project: { id: string; path: string } | null
  beadIds: string[]
  /** The Agents view shows the live tail; the narrow side panel only lists. */
  full: boolean
}) {
  const { tree, loaded, error } = useSessionTree(project?.path ?? '', beadIds)
  const [picked, setPicked] = useState<string | null>(null)
  if (!project) return null
  // Live: writing now, or a subagent is. Recently idle ones stay for context.
  const shown = tree.filter(node => isLive(node) || node.status === 'idle').slice(0, 8)
  const all = shown.flatMap(node => [node, ...node.children.filter(c => c.status !== 'finished' || isLive(node))])
  const selected = all.find(node => `${node.summary.provider}:${node.summary.id}` === picked) ?? shown.find(isLive) ?? shown[0] ?? null

  return <section style={styles.section} aria-label="Agent sessions" data-testid="live-sessions">
    <p style={styles.heading}>Agent sessions</p>
    {error && <p role="alert" style={{ ...styles.meta, color: 'var(--bs-red)' }}>{error}</p>}
    {loaded && shown.length === 0 && <p style={styles.meta}>No Claude, Codex or Qwen session is active in this folder. Start one from the top bar.</p>}
    <ul style={styles.list}>
      {shown.map(node => <li key={`${node.summary.provider}:${node.summary.id}`} style={styles.group}>
        <SessionRow node={node} active={selected === node} onPick={() => setPicked(`${node.summary.provider}:${node.summary.id}`)} />
        {node.children.filter(c => c.status !== 'finished' || isLive(node)).map(child =>
          <SessionRow key={child.summary.id} node={child} nested active={selected === child} onPick={() => setPicked(`${child.summary.provider}:${child.summary.id}`)} />)}
      </li>)}
    </ul>
    {full && selected && <LiveTail project={project} node={selected} />}
  </section>
}

function SessionRow({ node, nested, active, onPick }: { node: SessionNode; nested?: boolean; active: boolean; onPick: () => void }) {
  const { summary } = node
  return <button style={{ ...styles.row, marginLeft: nested ? 18 : 0, ...(active ? styles.rowActive : null) }} aria-current={active} onClick={onPick}>
    <StatusDot status={node.status} />
    <span style={styles.mark}><ProviderMark id={summary.provider} size={13} /></span>
    <span style={styles.rowTitle}>{summary.title}</span>
    {nested && summary.agentType && <span style={styles.chip}>{summary.agentType}</span>}
    {node.beads.map(id => <span key={id} style={styles.bead}>{id}</span>)}
    <span style={styles.meta}>{node.status === 'running' ? 'now' : relativeTime(summary.modifiedMs)}{node.duration ? ` · ${node.duration}` : ''}</span>
  </button>
}

/** The newest turns of one session, re-read while it is shown and the window is in front. */
function LiveTail({ project, node }: { project: { id: string; path: string }; node: SessionNode }) {
  const { summary } = node
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    setTranscript(null)
    const load = () => {
      if (document.visibilityState !== 'visible') return
      readTranscript(project.path, summary.provider, summary.id)
        .then(next => { if (!cancelled) { setTranscript(next); setError(null) } })
        .catch(failure => { if (!cancelled) setError(String(failure)) })
    }
    load()
    // A finished session will not change: read it once.
    const timer = node.status === 'finished' ? null : setInterval(load, TAIL_MS)
    return () => { cancelled = true; if (timer) clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.path, summary.provider, summary.id, node.status === 'finished'])
  const turns = transcript?.turns.slice(-TAIL_TURNS) ?? []
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight }, [transcript])
  return <div style={styles.tail} data-testid="live-tail">
    <div style={styles.tailHead}>
      <span style={styles.mark}><ProviderMark id={summary.provider} /></span>
      <strong style={styles.rowTitle}>{summary.title}</strong>
      <button style={styles.link} onClick={() => { if (!summary.parentId) requestHistoryFocus(project.id, summary); openDesignerView('history') }}>Open in History</button>
    </div>
    {error && <p role="alert" style={{ ...styles.meta, color: 'var(--bs-red)' }}>{error}</p>}
    <div ref={scroller} style={styles.tailBody}>
      {!transcript && !error && <p style={styles.meta}>Reading…</p>}
      {transcript && turns.length === 0 && <p style={styles.meta}>Nothing readable yet.</p>}
      {turns.map((turn, index) => <TurnView key={`${turn.at ?? ''}:${index}`} turn={turn} agentLabel={summary.provider === 'claude' ? 'Claude' : summary.provider === 'qwen' ? 'Qwen' : 'Codex'} />)}
    </div>
  </div>
}

const styles: Record<string, React.CSSProperties> = {
  section: { display: 'flex', flexDirection: 'column', gap: 6 },
  heading: { margin: 0, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--bs-fg-muted)', fontWeight: 700 },
  meta: { margin: 0, fontSize: 11, color: 'var(--bs-fg-muted)', flexShrink: 0 },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  group: { display: 'flex', flexDirection: 'column', gap: 2 },
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: '1px solid var(--bs-border)', borderRadius: 8, background: 'var(--bs-bg)', color: 'inherit', font: 'inherit', fontSize: 12, textAlign: 'left', cursor: 'pointer', minWidth: 0 },
  rowActive: { background: 'var(--bs-bg-dark)' },
  rowTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  mark: { display: 'inline-flex', color: 'var(--bs-fg-muted)', flexShrink: 0 },
  chip: { fontSize: 10, padding: '0 6px', borderRadius: 5, border: '1px solid var(--bs-border)', color: 'var(--bs-fg-muted)', flexShrink: 0 },
  bead: { fontSize: 10, fontFamily: 'var(--du-font-mono, ui-monospace, Menlo, monospace)', fontWeight: 600, color: 'var(--bs-green)', flexShrink: 0 },
  tail: { display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--bs-border)', borderRadius: 10, padding: 10, minHeight: 0 },
  tailHead: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
  tailBody: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto' },
  link: { border: 'none', background: 'transparent', color: 'var(--bs-fg-muted)', cursor: 'pointer', fontSize: 12, flexShrink: 0 },
}
