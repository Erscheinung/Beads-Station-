// The saved-conversation reader shared by every restored agent pane: a terminal
// pane that hosted a CLI (RestoredPane) and a restored chat pane
// (RestoredChatPane). It reads the CLI's own session file; reading starts
// nothing. The pane decides what its header and actions say.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { TurnView } from './designer/ConversationView'
import { ConversationSearch, useConversationFind } from './designer/ConversationSearch'
import { filterTurns, readTranscript, type Transcript, type TranscriptProvider } from './designer/transcripts'

const PAGE = 60

export function useConversationReader({ paneId, cwd, cli, sessionId, hidden = false, onFind }: {
  paneId: string
  cwd: string
  cli: TranscriptProvider | undefined
  sessionId: string | undefined
  /** The body is not on screen (for example the saved terminal screen is shown instead). */
  hidden?: boolean
  /** Workspace search opened this pane's conversation on a word. */
  onFind?: () => void
}) {
  const [conversation, setConversation] = useState<Transcript | null>(null)
  useEffect(() => {
    if (!cli || !sessionId) return
    let cancelled = false
    Promise.resolve(readTranscript(cwd, cli, sessionId))
      .then(result => { if (!cancelled && result?.turns) setConversation(result) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [cli, sessionId, cwd])

  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(PAGE)
  // Matches are shown in context by default; "Only matching turns" restores the old filter.
  const [onlyMatching, setOnlyMatching] = useState(false)
  const hasConversation = Boolean(conversation && conversation.turns.length > 0)
  const turns = useMemo(() => conversation ? (onlyMatching ? filterTurns(conversation.turns, query) : conversation.turns) : [], [conversation, query, onlyMatching])
  const visible = query ? turns : turns.slice(-shown)
  const scroller = useRef<HTMLDivElement>(null)
  const find = useConversationFind(scroller, query, visible.length)

  const onFindRef = useRef(onFind)
  onFindRef.current = onFind
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId: string; query: string }>).detail
      if (detail.paneId !== paneId) return
      onFindRef.current?.()
      setQuery(detail.query)
    }
    window.addEventListener('find:conversation', listener)
    return () => window.removeEventListener('find:conversation', listener)
  }, [paneId])

  // It opens at its end, where the work is.
  const scrolledFor = useRef<string | null>(null)
  useEffect(() => {
    const element = scroller.current
    if (!element || query || !hasConversation || hidden || scrolledFor.current === conversation!.id) return
    element.scrollTop = element.scrollHeight
    scrolledFor.current = conversation!.id
  }, [hasConversation, hidden, conversation, query])

  return { conversation, hasConversation, query, setQuery, onlyMatching, setOnlyMatching, turns, visible, shown, setShown, scroller, find }
}

export type ConversationReaderState = ReturnType<typeof useConversationReader>

export function ReaderSearch({ reader, onEscape }: { reader: ConversationReaderState; onEscape?: () => void }) {
  const { query, setQuery, find, onlyMatching, setOnlyMatching } = reader
  return <ConversationSearch query={query} onQuery={setQuery} count={find.count} index={find.index} onNext={find.next} onPrev={find.prev} onlyMatching={onlyMatching} onOnlyMatching={setOnlyMatching} onEscape={onEscape} />
}

export function ConversationBody({ reader, label }: { reader: ConversationReaderState; label: string }) {
  const { conversation, query, onlyMatching, turns, visible, shown, setShown, scroller, find } = reader
  return <div className="bs-saved-screen bs-restored__body" aria-label="Earlier conversation" data-testid="restored-conversation" ref={scroller as RefObject<HTMLDivElement>} tabIndex={0}>
    {conversation!.truncated && <p className="bs-restored__note">This session is large; the most recent part is shown.</p>}
    {!query && turns.length > shown && <button className="bs-restored__link" onClick={() => setShown(count => count + PAGE)}>Show {Math.min(PAGE, turns.length - shown)} earlier turns</button>}
    {query && (onlyMatching ? visible.length === 0 : find.count === 0) && <p className="bs-restored__note">Nothing in this conversation matches “{query}”.</p>}
    {visible.map((turn, index) => <TurnView key={`${turns.length - visible.length + index}`} turn={turn} agentLabel={label} highlight={find.words} />)}
  </div>
}
