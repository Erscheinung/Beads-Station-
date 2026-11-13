// Designer live session, after the Napkin model: the real agent CLI runs in a
// terminal on the left, and the files it has changed "spill" on the right.
// Nothing starts until the user picks what to run.

import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Terminal } from '../Terminal'
import { disposeTerminalSession, hasTerminalSession, pasteIntoTerminalSession, runInTerminalSession } from '../../lib/terminalSessions'
import { agentStartCommand } from '../../state/agentHooks'
import { setFocused } from '../../state/vim'
import { setInsert } from '../../state/termPanes'
import { requestDestructiveAction } from '../../state/destructiveActions'
import type { Issue } from '../../types/issue'
import { approveArtifact, captureArtifact, requestArtifactChanges, useArtifactReview, type ArtifactRevision } from './artifacts'
import { submitSessionAttempt } from './nativeRuns'
import { bdCloseIssue } from '../../types/issue'
import { fileChanges, ticketPrompt, type FileChange } from './sessionChanges'

type SessionKind = 'claude' | 'codex' | 'shell'
const KIND_LABEL: Record<SessionKind, string> = { claude: 'Claude Code', codex: 'Codex', shell: 'Shell' }

// A new shell runs its command once it has printed a prompt. Keyed by pane so
// a StrictMode remount cannot run it twice.
const startupCommands = new Map<string, string>()
function onSpawn(paneId: string) {
  const command = startupCommands.get(paneId)
  startupCommands.delete(paneId)
  if (command) runInTerminalSession(paneId, command)
}

/** The ticket a workspace's session is working on, and the attempt under review. */
interface SessionWork { ticketId: string; title: string; attemptId: string }
// Kept outside the component so leaving the Session view does not forget it.
const sessionWork = new Map<string, SessionWork>()

// A command the History view wants the Session to start with (resume a past
// conversation). The user already clicked "Resume"; the Session view runs it once.
const pendingStarts = new Map<string, string>()
export function requestSessionStart(projectId: string, command: string) {
  pendingStarts.set(projectId, command)
}
export function sessionIsRunning(projectId: string) {
  return hasTerminalSession(designerSessionPaneId(projectId))
}

export function designerSessionPaneId(projectId: string) {
  return `designer:${projectId}`
}

const REFRESH_MS = 10_000

function useWorkspaceChanges(workspacePath: string, live: boolean) {
  const [changes, setChanges] = useState<FileChange[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const revision = await invoke<ArtifactRevision | null>('artifact_preview', { workspacePath })
      setChanges(revision ? fileChanges(revision) : [])
      setError(null)
    } catch (failure) {
      setError(String(failure))
    } finally {
      inFlight.current = false
    }
  }, [workspacePath])

  useEffect(() => {
    setChanges(null)
    void refresh()
  }, [refresh])
  // While a session runs, look again every few seconds, but only when the
  // window is in front: a hidden app should not keep reading the workspace.
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [live, refresh])

  return { changes, error, refresh }
}

export function SessionView({ project, issue, onClearIssue }: {
  project: { id: string; name: string; path: string }
  /** The ticket the user chose to work on, if they came from a request. */
  issue: Issue | null
  onClearIssue: () => void
}) {
  const paneId = designerSessionPaneId(project.id)
  const [running, setRunning] = useState(() => hasTerminalSession(paneId))
  const [open, setOpen] = useState<string | null>(null)
  const { changes, error, refresh } = useWorkspaceChanges(project.path, running)
  const [work, setWorkState] = useState<SessionWork | null>(() => sessionWork.get(project.id) ?? null)
  const setWork = (next: SessionWork | null) => {
    if (next) sessionWork.set(project.id, next); else sessionWork.delete(project.id)
    setWorkState(next)
  }
  const workOn = (ticket: Issue) => setWork({ ticketId: ticket.id, title: ticket.title, attemptId: crypto.randomUUID() })

  // A start that is queued but whose terminal has not mounted yet still counts as running.
  useEffect(() => { setRunning(hasTerminalSession(paneId) || startupCommands.has(paneId)); setOpen(null) }, [paneId])

  // A resume requested from History starts here, but only if nothing is running.
  useEffect(() => {
    const command = pendingStarts.get(project.id)
    pendingStarts.delete(project.id)
    if (!command || hasTerminalSession(paneId)) return
    startupCommands.set(paneId, command)
    setRunning(true)
    setFocused('terminal'); setInsert(true)
  }, [project.id, paneId])

  const typeHere = () => { setFocused('terminal'); setInsert(true) }

  const start = (kind: SessionKind, withTicket: boolean) => {
    const prompt = withTicket && issue ? ticketPrompt(issue) : null
    if (kind !== 'shell') startupCommands.set(paneId, agentStartCommand(kind, prompt))
    if (withTicket && issue) { workOn(issue); onClearIssue() }
    setRunning(true)
    typeHere()
  }

  const end = () => requestDestructiveAction({
    kind: 'pane',
    title: 'End this session?',
    detail: 'This stops the shell and anything running in it. Changed files stay as they are.',
    onConfirm: () => {
      startupCommands.delete(paneId)
      disposeTerminalSession(paneId)
      setRunning(false)
      void refresh()
    },
  })

  const total = (changes ?? []).reduce((sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }), { added: 0, removed: 0 })

  return <div style={styles.root} data-testid="designer-session">
    <section style={styles.talk}>
      <header style={styles.header}>
        <div>
          <h2 style={styles.title}>Session</h2>
          <p style={styles.meta}>{project.name} · {running ? 'running' : 'not started'}</p>
        </div>
        {running && <button style={styles.quiet} onClick={end}>End session</button>}
      </header>

      {issue && <div style={styles.ticket} data-testid="designer-session-ticket">
        <div style={{ minWidth: 0 }}>
          <p style={styles.eyebrow}>TICKET · {issue.id}</p>
          <p style={styles.ticketTitle}>{issue.title}</p>
        </div>
        <div style={styles.actions}>
          {running
            ? <button style={styles.primary} onClick={() => { if (pasteIntoTerminalSession(paneId, ticketPrompt(issue))) { workOn(issue); onClearIssue(); typeHere() } }}>Paste ticket into session</button>
            : <>
              <button style={styles.primary} onClick={() => start('claude', true)}>Start Claude Code on it</button>
              <button style={styles.quiet} onClick={() => start('codex', true)}>Start Codex on it</button>
            </>}
          <button style={styles.quiet} onClick={onClearIssue}>Dismiss</button>
        </div>
      </div>}

      {running
        ? <div style={styles.terminal} onMouseDown={typeHere}>
          {/* Absolutely positioned so xterm measures the frame, not its own rows. */}
          <div style={styles.terminalFill}>
            <Terminal paneId={paneId} cwd={project.path} onSpawn={onSpawn} focused insert viewEpoch={paneId} />
          </div>
        </div>
        : <div style={styles.empty}>
          <p style={styles.emptyTitle}>What are we making?</p>
          <p style={styles.meta}>Start a session in {project.name}. The real CLI runs here, with your own login. Nothing runs until you choose.</p>
          <div style={styles.actions}>
            {(['claude', 'codex', 'shell'] as const).map(kind =>
              <button key={kind} style={kind === 'claude' ? styles.primary : styles.quiet} onClick={() => start(kind, false)}>{kind === 'shell' ? 'Plain shell' : `Start ${KIND_LABEL[kind]}`}</button>)}
          </div>
        </div>}
    </section>

    <aside style={styles.spill} aria-label="Changed files">
      <header style={styles.header}>
        <div>
          <h2 style={styles.title}>Changes</h2>
          <p style={styles.meta}>{changes === null ? 'Reading…' : changes.length === 0 ? 'Nothing changed yet' : `${changes.length} file${changes.length === 1 ? '' : 's'} · +${total.added} −${total.removed}`}</p>
        </div>
        <button style={styles.quiet} onClick={() => void refresh()}>Refresh</button>
      </header>
      {error && <p role="alert" style={{ ...styles.meta, color: 'var(--bs-red)' }}>{error}</p>}
      <ul style={styles.files}>
        {(changes ?? []).map(change => <li key={change.path}>
          <button style={styles.file} aria-expanded={open === change.path} onClick={() => setOpen(current => current === change.path ? null : change.path)}>
            <span style={{ ...styles.kind, color: KIND_COLOR[change.kind] }}>{change.kind}</span>
            <span style={styles.path} title={change.path}>{change.path}</span>
            <span style={styles.counts}><span style={{ color: 'var(--bs-green)' }}>+{change.added}</span> <span style={{ color: 'var(--bs-red)' }}>−{change.removed}</span></span>
          </button>
          {open === change.path && <pre style={styles.diff}>{change.diff ?? change.content ?? 'No preview for this file.'}</pre>}
        </li>)}
      </ul>
      {work
        ? <SessionReview key={`${work.ticketId}:${work.attemptId}`} project={project} work={work} paneId={paneId}
            onNextAttempt={() => setWork({ ...work, attemptId: crypto.randomUUID() })}
            onDone={() => setWork(null)} onCaptured={() => void refresh()} />
        : <p style={styles.meta}>To review work against a ticket, open a request and choose “Open in a live session”.</p>}
    </aside>
  </div>
}

/**
 * The review gate for a session's ticket. "Capture" is the user saying the
 * work is ready: it records the attempt, freezes the changed files, and only
 * that exact capture can be approved.
 */
function SessionReview({ project, work, paneId, onNextAttempt, onDone, onCaptured }: {
  project: { id: string; path: string }
  work: SessionWork
  paneId: string
  onNextAttempt: () => void
  onDone: () => void
  onCaptured: () => void
}) {
  const identity = { workspaceId: project.id, ticketId: work.ticketId, runId: `${project.id}:${work.ticketId}:${work.attemptId}`, attemptId: work.attemptId }
  const review = useArtifactReview(identity, 'needs_review')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [closed, setClosed] = useState(false)

  const guarded = async (action: () => Promise<void>) => {
    setBusy(true); setProblem(null)
    try { await action() } catch (failure) { setProblem(String(failure)) } finally { setBusy(false) }
  }
  const capture = () => guarded(async () => {
    await submitSessionAttempt({ workspaceId: project.id, ticketId: work.ticketId, attemptId: work.attemptId, cwd: project.path })
    await captureArtifact(identity, project.path)
    onCaptured()
  })
  const approve = () => guarded(async () => { if (review.revision) await approveArtifact(review.revision, 'needs_review') })
  const close = () => guarded(async () => {
    await bdCloseIssue(project.path, work.ticketId, `Approved revision ${review.revision?.revisionId ?? ''} in Beads Station`)
    setClosed(true)
  })
  const requestChanges = () => {
    const text = feedback.trim()
    if (!text) return
    try {
      requestArtifactChanges(identity, text)
      // The request goes to the agent's prompt; the user sends it.
      pasteIntoTerminalSession(paneId, text)
      setFeedback('')
      onNextAttempt()
    } catch (failure) { setProblem(String(failure)) }
  }

  return <section style={styles.review} data-testid="designer-session-review">
    <p style={styles.eyebrow}>REVIEW · {work.ticketId}</p>
    <p style={styles.ticketTitle}>{work.title}</p>
    {closed
      ? <><p style={styles.meta}>Ticket closed.</p><button style={styles.quiet} onClick={onDone}>Done</button></>
      : <>
        {review.revision
          ? <p style={styles.meta} data-testid="designer-session-revision">Captured {review.revision.files.length} file{review.revision.files.length === 1 ? '' : 's'} · {review.revision.revisionHash.slice(0, 12)}{review.approval ? ' · approved' : ''}</p>
          : <p style={styles.meta}>When the work looks right, capture it. Approval applies to that exact capture.</p>}
        <div style={styles.actions}>
          {!review.approval && <button style={review.revision ? styles.quiet : styles.primary} disabled={busy} onClick={() => void capture()}>{busy && !review.revision ? 'Capturing…' : review.revision ? 'Capture again' : 'Capture for review'}</button>}
          {review.revision && !review.approval && <button style={styles.primary} disabled={busy} onClick={() => void approve()}>Approve</button>}
          {review.approval && <button style={styles.primary} disabled={busy} onClick={() => void close()}>Close ticket</button>}
          <button style={styles.quiet} onClick={onDone}>{review.approval ? 'Leave open' : 'Stop reviewing'}</button>
        </div>
        {review.revision && !review.approval && <>
          <textarea value={feedback} onChange={event => setFeedback(event.target.value)} placeholder="What should change?" aria-label="Requested changes" style={styles.feedback} />
          <button style={styles.quiet} disabled={!feedback.trim() || busy} onClick={requestChanges}>Request changes</button>
        </>}
      </>}
    {problem && <p role="alert" style={{ ...styles.meta, color: 'var(--bs-red)' }}>{problem}</p>}
  </section>
}

const KIND_COLOR: Record<FileChange['kind'], string> = { new: 'var(--bs-green)', edited: 'var(--bs-orange)', gone: 'var(--bs-red)' }

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(240px, 32%)', gap: 16, height: '100%', minHeight: 0, padding: 16, boxSizing: 'border-box' },
  talk: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, minHeight: 0 },
  spill: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, minHeight: 0, borderLeft: '1px solid var(--bs-border)', paddingLeft: 16 },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  title: { margin: 0, fontSize: 18, fontWeight: 600 },
  meta: { margin: '2px 0 0', fontSize: 12, color: 'var(--bs-fg-muted)' },
  eyebrow: { margin: 0, fontSize: 11, letterSpacing: '0.06em', color: 'var(--bs-fg-muted)' },
  ticket: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '10px 12px', border: '1px solid var(--bs-border)', borderRadius: 10, background: 'var(--bs-bg)' },
  ticketTitle: { margin: '2px 0 0', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  primary: { padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--bs-orange)', color: '#fff', fontWeight: 600, cursor: 'pointer' },
  quiet: { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg)', cursor: 'pointer' },
  // The terminal keeps its own dark palette; the frame gives it a paper edge.
  terminal: { flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', borderRadius: 10, border: '1px solid var(--bs-border)', background: 'var(--bs-terminal-bg, #1f2335)' },
  terminalFill: { position: 'absolute', inset: 6 },
  empty: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', gap: 12, padding: 32, border: '1px dashed var(--bs-border)', borderRadius: 10 },
  emptyTitle: { margin: 0, fontSize: 26, fontWeight: 600 },
  files: { listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1, minHeight: 0 },
  file: { display: 'grid', gridTemplateColumns: '52px minmax(0, 1fr) auto', gap: 8, alignItems: 'baseline', width: '100%', padding: '6px 4px', border: 'none', borderBottom: '1px solid var(--bs-border)', background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' },
  kind: { fontSize: 11, fontWeight: 600 },
  path: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--du-font-mono, ui-monospace, Menlo, monospace)', fontSize: 12 },
  counts: { fontSize: 12, fontVariantNumeric: 'tabular-nums' },
  review: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10, borderTop: '1px solid var(--bs-border)' },
  feedback: { minHeight: 56, padding: 8, borderRadius: 8, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg)', font: 'inherit', resize: 'vertical' },
  diff: { margin: '0 0 8px', padding: 8, maxHeight: 320, overflow: 'auto', fontSize: 11, lineHeight: 1.5, background: 'var(--bs-bg)', border: '1px solid var(--bs-border)', borderRadius: 6, whiteSpace: 'pre' },
}
