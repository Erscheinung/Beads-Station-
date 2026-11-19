// A restored "New Claude agent pane" (the older JSON chat, `leaf.agent`). With a
// provider-observed session id it reads as the saved conversation, like a
// restored terminal pane (RestoredPane): one primary Continue (Enter), and
// Start new session as the secondary action. Nothing starts before a click;
// without an id the plain card says what to do next.

import { useEffect, useRef } from 'react'
import { activateRestoredPane, type Leaf } from '../state/termPanes'
import { clearObservedProviderSession, type ObservedProvider } from '../state/sessionPreferences'
import { ConversationBody, ReaderSearch, useConversationReader } from './ConversationReader'
import { usageLine } from './designer/transcripts'

export function RestoredChatPane({ leaf, provider, observedId, focused }: {
  leaf: Leaf
  provider: ObservedProvider
  observedId: string | null
  focused: boolean
}) {
  const a = leaf.agent!
  const label = provider === 'claude' ? 'Claude' : 'Codex'
  const reader = useConversationReader({ paneId: leaf.paneId, cwd: leaf.cwd, cli: provider, sessionId: observedId ?? undefined })
  const { conversation, hasConversation } = reader

  const startNew = () => {
    clearObservedProviderSession(provider, a.bridgeId)
    activateRestoredPane(leaf.paneId)
  }

  // Focusing the pane puts the cursor on the primary action, so Enter continues.
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focused && hasConversation) primary.current?.focus({ preventScroll: true })
  }, [focused, hasConversation])

  if (!observedId) {
    return <div data-restored-provider={a.bridgeId} className="bs-restored" style={{ placeContent: 'center', gap: 10, padding: 20, textAlign: 'center', color: 'var(--bs-fg-muted)' }}>
      <strong style={{ color: 'var(--bs-fg)' }}>Saved {label} chat</strong>
      <span>This chat never recorded which conversation it was, so there is nothing to read or continue here.</span>
      <span>Press “Start new session” for a fresh chat; your earlier conversations are in History. Nothing has started.</span>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
        <button onClick={startNew}>Start new session</button>
      </div>
    </div>
  }

  return <div className="bs-restored" data-restored-provider={a.bridgeId} data-restored-pane={leaf.paneId}>
    <div className="bs-restored__head">
      <span className={`bs-restored__badge bs-restored__badge--${provider}`}>{label}</span>
      <span className="bs-restored__title">This chat’s conversation</span>
      <span className="bs-restored__meta">not running{hasConversation ? ` · ${usageLine(conversation!.usage)}` : ''}</span>
      <span className="bs-restored__spacer" />
      {hasConversation && <ReaderSearch reader={reader} onEscape={() => primary.current?.focus()} />}
    </div>
    {hasConversation
      ? <ConversationBody reader={reader} label={label} />
      : <div className="bs-saved-screen" tabIndex={0}>
        <p className="bs-restored__note">{conversation ? 'Nothing readable in this conversation yet.' : 'Looking for the conversation…'}</p>
        <p className="bs-restored__note">Session {observedId}</p>
      </div>}
    <div className="bs-restored__composer">
      <span className="bs-restored__spacer" style={{ flex: 1 }} />
      <button ref={primary} className="bs-restored__primary" title={provider === 'claude' ? 'Reopens this chat on the same Claude conversation' : undefined} onClick={() => activateRestoredPane(leaf.paneId)}>Continue</button>
      <button onClick={startNew} title="Forget this conversation and open an empty chat">Start new session</button>
    </div>
    <p className="bs-restored__foot">
      {provider === 'claude' ? 'Continue reopens this exact conversation.' : 'Codex chats cannot reattach to a thread yet: Continue opens a new chat, and this conversation stays in History.'}
      {' '}Nothing has started.
    </p>
  </div>
}
