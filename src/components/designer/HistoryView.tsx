// Designer Desk (Code-05b.1): past and running agent sessions, read as a
// formatted conversation. It only reads the CLIs' own session files, so
// opening a session here starts nothing and costs no tokens. Resuming one is a
// separate, explicit click that hands the id to the Session view.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TurnView } from './ConversationView'
import { addShelfItem } from './shelf'
import {
  filterTurns, formatTokens, listTranscripts, pace, readMeter, takeHistoryFocus, windowLabel,
  type LimitWindow, type Meter, readTranscript, relativeTime, turnProse, usageLine,
  type Transcript, type TranscriptSummary, type TranscriptTurn,
} from './transcripts'

const REFRESH_MS = 8_000
/** Older turns are folded behind a button so a long session opens instantly. */
const SHOWN_TURNS = 120
const PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const

export function HistoryView({ project, sessionRunning, onResume }: {
  project: { id: string; name: string; path: string }
  /** The Session view already has a live terminal; resuming must not type into it. */
  sessionRunning: boolean
  onResume: (summary: TranscriptSummary) => void
}) {
  const [list, setList] = useState<TranscriptSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<TranscriptSummary | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [query, setQuery] = useState('')
  const [pinned, setPinned] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stickToEnd = useRef(true)

  const refreshList = useCallback(async () => {
    try {
      const next = await listTranscripts(project.path)
      setList(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
      setError(null)
      // A ticket page may have asked for one session to be open.
      const wanted = takeHistoryFocus(project.id)
      if (wanted) {
        const match = next.find(item => `${item.provider}:${item.id}` === wanted)
        if (match) { stickToEnd.current = true; setTranscript(null); setQuery(''); setShowAll(false); setSelected(match) }
      }
      // Follow the selected session as it grows.
      setSelected(current => current ? next.find(item => item.id === current.id && item.provider === current.provider) ?? current : current)
    } catch (failure) { setError(String(failure)) }
  }, [project.path, project.id])

  useEffect(() => { setList(null); setSelected(null); setTranscript(null); void refreshList() }, [refreshList])
  // Only look again while the window is in front: a hidden app reads nothing.
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshList() }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [refreshList])

  const selectedKey = selected ? `${selected.provider}:${selected.id}:${selected.modifiedMs}` : null
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    readTranscript(project.path, selected.provider, selected.id)
      .then(result => { if (!cancelled) { setTranscript(result); setError(null) } })
      .catch(failure => { if (!cancelled) setError(String(failure)) })
    return () => { cancelled = true }
    // Re-read when the file changed on disk (modifiedMs is part of the key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.path, selectedKey])

  const choose = (summary: TranscriptSummary) => {
    if (selected?.id === summary.id) return
    stickToEnd.current = true
    setTranscript(null); setQuery(''); setShowAll(false)
    setSelected(summary)
  }

  const visible = useMemo(() => transcript ? filterTurns(transcript.turns, query) : [], [transcript, query])
  const shown = showAll || query ? visible : visible.slice(-SHOWN_TURNS)
  const folded = visible.length - shown.length

  // A session opens at its end, where the work is. Scrolling up stops following.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && stickToEnd.current) element.scrollTop = element.scrollHeight
  }, [transcript, shown.length])
  const onScroll = () => {
    const element = scroller.current
    if (element) stickToEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
  }
  const jump = (to: 'start' | 'end') => {
    const element = scroller.current
    if (!element) return
    stickToEnd.current = to === 'end'
    element.scrollTo({ top: to === 'end' ? element.scrollHeight : 0 })
  }

  const pin = (turn: TranscriptTurn, index: number) => {
    const prose = turnProse(turn)
    if (!prose) return
    addShelfItem(project.id, { kind: 'note', value: prose, source: selected ? `${PROVIDER_LABEL[selected.provider]} session` : undefined })
    setPinned(index)
    setTimeout(() => setPinned(current => current === index ? null : current), 1500)
  }

  return <div style={styles.root} data-testid="designer-history">
    <aside style={styles.list} aria-label="Sessions">
      <header style={styles.listHeader}>
        <h2 style={styles.title}>History</h2>
        <p style={styles.meta}>{project.name}</p>
      </header>
      {error && !selected && <p role="alert" style={{ ...styles.meta, color: 'var(--bs-red)' }}>{error}</p>}
      {list === null && !error && <p style={styles.meta}>Reading sessions…</p>}
      {list?.length === 0 && <p style={styles.meta}>No Claude or Codex sessions have run in this folder yet.</p>}
      <ul style={styles.items}>
        {(list ?? []).map(item => {
          const active = selected?.id === item.id
          return <li key={`${item.provider}:${item.id}`}>
            <button style={{ ...styles.item, ...(active ? styles.itemActive : null) }} aria-current={active} onClick={() => choose(item)}>
              <span style={styles.itemTitle}>{item.title}</span>
              <span style={styles.meta}>{PROVIDER_LABEL[item.provider]} · {relativeTime(item.modifiedMs)}</span>
            </button>
          </li>
        })}
      </ul>
      <MeterCard />
    </aside>

    <section style={styles.reader} aria-label="Conversation">
      {!selected && <div style={styles.empty}>
        <p style={styles.emptyTitle}>Read any session, no resume needed</p>
        <p style={styles.meta}>Pick one on the left. This reads the agent’s own session file, so it uses no tokens and works while a terminal is still running the same session.</p>
      </div>}
      {selected && <>
        <header style={styles.readerHeader}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ ...styles.title, ...styles.ellipsis }} title={selected.title}>{selected.title}</h2>
            <p style={styles.meta} data-testid="history-usage">{PROVIDER_LABEL[selected.provider]} · {transcript ? usageLine(transcript.usage) : 'Loading…'}</p>
          </div>
          <div style={styles.actions}>
            <button style={styles.quiet} onClick={() => jump('start')}>Top</button>
            <button style={styles.quiet} onClick={() => jump('end')}>Latest</button>
            <button style={sessionRunning ? { ...styles.primary, ...styles.off } : styles.primary} disabled={sessionRunning} title={sessionRunning ? 'End the running session first (Session view)' : 'Starts the CLI and resumes this conversation'} onClick={() => onResume(selected)}>Resume in Session</button>
          </div>
        </header>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search this conversation" aria-label="Search this conversation" style={styles.search} />
        {error && <p role="alert" style={{ ...styles.meta, color: 'var(--bs-red)' }}>{error}</p>}
        <div ref={scroller} onScroll={onScroll} style={styles.scroll} data-testid="history-scroll">
          {transcript?.truncated && <p style={styles.note}>This session is large; the most recent part is shown.</p>}
          {folded > 0 && <button style={styles.quiet} onClick={() => setShowAll(true)}>Show {folded} earlier turn{folded === 1 ? '' : 's'}</button>}
          {transcript && visible.length === 0 && <p style={styles.meta}>{query ? 'No turn matches that search.' : 'Nothing readable in this session yet.'}</p>}
          {shown.map((turn, index) => <TurnView key={`${turn.at ?? ''}:${index}:${turn.role}`} turn={turn} pinned={pinned === index} onPin={() => pin(turn, index)} />)}
        </div>
      </>}
    </section>
  </div>
}

/**
 * Local usage, CodexBar-style: Codex's own rate-limit windows against an even
 * burn, and Claude's output tokens for the week. Read from the CLIs' files.
 */
function MeterCard() {
  const [meter, setMeter] = useState<Meter | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => { if (document.visibilityState === 'visible') readMeter().then(next => { if (!cancelled) setMeter(next) }).catch(() => undefined) }
    load()
    const timer = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])
  if (!meter) return null
  const peak = Math.max(1, ...meter.claudeDays.map(day => day.output))
  const windows = [meter.codex?.primary, meter.codex?.secondary].filter((w): w is LimitWindow => Boolean(w))
  return <section style={styles.meter} aria-label="Usage" data-testid="history-meter">
    <p style={styles.role}>Usage</p>
    {windows.map(w => {
      const p = pace(w)
      return <div key={w.windowMinutes} style={{ marginTop: 6 }}>
        <div style={styles.meterRow}><span>Codex {windowLabel(w.windowMinutes)}</span><span>{p.status === 'reset' ? '—' : `${Math.round(p.used)}%`}</span></div>
        <div style={styles.track} role="img" aria-label={`${Math.round(p.used)} percent used, ${p.elapsed.toFixed(0)} percent of the window elapsed`}>
          <div style={{ ...styles.fill, width: `${p.used}%`, background: p.status === 'ahead' ? 'var(--bs-orange)' : 'var(--bs-green)' }} />
          <div style={{ ...styles.tick, left: `${p.elapsed}%` }} />
        </div>
        <p style={styles.meta}>{p.resetsIn}{p.status === 'ahead' ? ' · ahead of even pace' : ''}</p>
      </div>
    })}
    {meter.codex && <p style={styles.meta}>Codex reading from {meter.codex.observedAt ? new Date(meter.codex.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'its last session'}; not live.</p>}
    <div style={{ ...styles.meterRow, marginTop: 8 }}><span>Claude output, 7 days</span><span>{formatTokens(meter.claudeDays.reduce((sum, day) => sum + day.output, 0))}</span></div>
    <div style={styles.bars} aria-hidden>
      {meter.claudeDays.map(day => <div key={day.day} title={`${day.day}: ${formatTokens(day.output)} out`} style={{ ...styles.bar, height: `${Math.max(2, (day.output / peak) * 100)}%` }} />)}
    </div>
    {meter.incomplete && <p style={styles.meta}>Some large sessions were only partly read, so totals may be low.</p>}
  </section>
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'grid', gridTemplateColumns: 'minmax(200px, 30%) minmax(0, 1fr)', gap: 16, height: '100%', minHeight: 0, padding: 16, boxSizing: 'border-box' },
  list: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, minWidth: 0, borderRight: '1px solid var(--bs-border)', paddingRight: 12 },
  listHeader: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  items: { listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1, minHeight: 0 },
  item: { display: 'flex', flexDirection: 'column', gap: 2, width: '100%', padding: '8px 8px', border: 'none', borderBottom: '1px solid var(--bs-border)', background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer', borderRadius: 6 },
  itemActive: { background: 'var(--bs-bg-dark)' },
  itemTitle: { fontWeight: 600, fontSize: 13, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
  meter: { borderTop: '1px solid var(--bs-border)', paddingTop: 8, fontSize: 12 },
  meterRow: { display: 'flex', justifyContent: 'space-between', gap: 8 },
  track: { position: 'relative', height: 6, borderRadius: 3, background: 'var(--bs-border)', marginTop: 3 },
  fill: { height: '100%', borderRadius: 3 },
  tick: { position: 'absolute', top: -2, bottom: -2, width: 2, background: 'var(--bs-fg-muted)' },
  bars: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 36, marginTop: 4 },
  bar: { flex: 1, background: 'var(--bs-orange)', borderRadius: 2, opacity: 0.8 },
  reader: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, minWidth: 0 },
  readerHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  title: { margin: 0, fontSize: 18, fontWeight: 600 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: { margin: '2px 0 0', fontSize: 12, color: 'var(--bs-fg-muted)' },
  note: { margin: 0, fontSize: 12, color: 'var(--bs-fg-muted)' },
  actions: { display: 'flex', gap: 8, flexShrink: 0 },
  off: { opacity: 0.45, cursor: 'not-allowed' },
  primary: { padding: '7px 12px', borderRadius: 8, border: 'none', background: 'var(--bs-orange)', color: '#fff', fontWeight: 600, cursor: 'pointer' },
  quiet: { padding: '6px 10px', borderRadius: 8, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg)', cursor: 'pointer', alignSelf: 'flex-start' },
  link: { marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--bs-fg-muted)', cursor: 'pointer', fontSize: 12 },
  search: { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg)', font: 'inherit' },
  scroll: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 6 },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8, padding: 32, border: '1px dashed var(--bs-border)', borderRadius: 10 },
  emptyTitle: { margin: 0, fontSize: 22, fontWeight: 600 },
  turn: { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', fontSize: 13, lineHeight: 1.55, flexShrink: 0 },
  userTurn: { background: 'var(--bs-bg-dark)' },
  turnHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 },
  role: { fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--bs-fg-muted)', fontWeight: 600 },
  userText: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  tool: { margin: '4px 0', fontSize: 12 },
  toolSummary: { cursor: 'pointer', color: 'var(--bs-fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  toolArg: { fontFamily: 'var(--du-font-mono, ui-monospace, Menlo, monospace)' },
  toolResult: { margin: '4px 0 0', padding: 8, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, background: 'var(--bs-bg-dark)', borderRadius: 6 },
  files: { margin: '6px 0 0', fontSize: 12, color: 'var(--bs-fg-muted)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
  file: { padding: '1px 6px', borderRadius: 4, background: 'var(--bs-bg-dark)', fontSize: 11 },
}
