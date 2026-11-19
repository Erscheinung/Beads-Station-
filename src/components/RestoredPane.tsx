// A terminal pane that hosted Claude or Codex before the app stopped.
//
// The pane body is the conversation itself, read from the CLI's own session
// file: scrollable, searchable, formatted. Nothing runs until the user
// continues it, and continuing is the first thing they would do anyway: press
// Enter in the message box (empty reopens the CLI, a message reopens it and
// sends that message). The raw saved screen stays one click away.

import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { activateRestoredPane, claimedAgentSessions, paneResumeCommand, setInsert, type Leaf } from '../state/termPanes'
import { AGENT_CLI_LABEL, agentResumeCommand, useAgentHooks } from '../state/agentHooks'
import { shouldAutoResumeAgents, useSessionPreferences } from '../state/sessionPreferences'
import { ConversationBody, ReaderSearch, useConversationReader } from './ConversationReader'
import { listTranscripts, relativeTime, usageLine } from './designer/transcripts'
import { recoverSession } from '../lib/restoredSession'
import { abbreviatePathsIn } from '../lib/abbreviatePath'

export function RestoredPane({ leaf, focused }: { leaf: Leaf; focused: boolean }) {
  // Re-render when the hook settings path or the user's CLI command changes: both are part of the command shown.
  useAgentHooks()
  useSessionPreferences()
  const cli = leaf.agentCli

  // A kept shell may still be running. Attaching to it starts nothing, so it
  // needs no click; everything else waits until that is known, because a resume
  // command must never be typed into a program that is already there.
  const [checking, setChecking] = useState(Boolean(leaf.hostKey))
  useEffect(() => {
    if (!leaf.hostKey) return
    let cancelled = false
    invoke<string[]>('pty_persisted', { keys: [leaf.hostKey] })
      .then(alive => {
        if (cancelled) return
        if (Array.isArray(alive) && alive.includes(leaf.hostKey!)) activateRestoredPane(leaf.paneId)
        else setChecking(false)
      })
      .catch(() => { if (!cancelled) setChecking(false) })
    return () => { cancelled = true }
  }, [leaf.hostKey, leaf.paneId])

  // The pane's own session id, or the most likely one when it never learned it.
  const [recovered, setRecovered] = useState<string | null>(null)
  const [lookedUp, setLookedUp] = useState(Boolean(leaf.agentSessionId) || !cli)
  useEffect(() => {
    if (!cli || leaf.agentSessionId) return
    let cancelled = false
    Promise.resolve(listTranscripts(leaf.cwd))
      .then(summaries => {
        if (cancelled || !Array.isArray(summaries)) return
        setRecovered(recoverSession(summaries, cli, leaf.savedScreen?.capturedAt, claimedAgentSessions())?.id ?? null)
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLookedUp(true) })
    return () => { cancelled = true }
  }, [cli, leaf.agentSessionId, leaf.cwd, leaf.savedScreen?.capturedAt])
  const sessionId = leaf.agentSessionId ?? recovered ?? undefined

  const [showScreen, setShowScreen] = useState(false)
  const [message, setMessage] = useState('')
  const reader = useConversationReader({ paneId: leaf.paneId, cwd: leaf.cwd, cli, sessionId, hidden: showScreen, onFind: () => setShowScreen(false) })
  const { conversation, hasConversation } = reader

  const proceed = (resume: boolean) => {
    if (checking) return
    if (resume && cli) activateRestoredPane(leaf.paneId, { resumeAgentCli: true, sessionId, prompt: message })
    else activateRestoredPane(leaf.paneId)
  }

  // Opt-in (Settings → Sessions, off by default): reopen the CLI as soon as the
  // pane is shown, but only for a conversation that is known, never "the latest".
  const autoStarted = useRef(false)
  useEffect(() => {
    if (autoStarted.current || checking || !lookedUp || !cli || !sessionId || !shouldAutoResumeAgents()) return
    autoStarted.current = true
    activateRestoredPane(leaf.paneId, { resumeAgentCli: true, sessionId })
  }, [checking, lookedUp, cli, sessionId, leaf.paneId])

  // The message box is the pane's cursor: focusing the pane focuses it.
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focused && !checking) input.current?.focus({ preventScroll: true })
  }, [focused, checking])

  const label = cli ? AGENT_CLI_LABEL[cli] : 'shell'
  const command = cli ? (sessionId ? agentResumeCommand(cli, sessionId) : paneResumeCommand(leaf)) : null
  const savedAt = leaf.savedScreen?.capturedAt
  const which = leaf.agentSessionId
    ? 'This pane’s conversation'
    : recovered ? `Most recent ${label} conversation in this folder` : `${label} was running here`

  return <div className="bs-restored" data-restored-pane={leaf.paneId}>
    <div className="bs-restored__head">
      {cli && <span className={`bs-restored__badge bs-restored__badge--${cli}`}>{label}</span>}
      <span className="bs-restored__title">{which}</span>
      <span className="bs-restored__meta">
        {savedAt && savedAt > 1_000_000 ? `saved ${relativeTime(savedAt)} · ` : ''}not running{hasConversation && !showScreen ? ` · ${usageLine(conversation!.usage)}` : ''}
      </span>
      <span className="bs-restored__spacer" />
      {hasConversation && !showScreen && <ReaderSearch reader={reader} onEscape={() => input.current?.focus()} />}
      {hasConversation && <button className="bs-restored__link" onClick={() => setShowScreen(value => !value)}>{showScreen ? 'Show conversation' : 'Show saved screen'}</button>}
    </div>
    {hasConversation && !showScreen
      ? <ConversationBody reader={reader} label={label} />
      : <div className="bs-saved-screen" tabIndex={0}>
        {!hasConversation && cli && <p className="bs-restored__note">{!lookedUp || (sessionId && !conversation) ? 'Looking for the conversation…' : 'No saved conversation was found for this pane; this is the last screen it showed.'}</p>}
        <pre aria-label="Saved terminal screen">{leaf.savedScreen?.lines.join('\n') || 'No terminal screen was captured before the app stopped.'}</pre>
      </div>}
    <form className="bs-restored__composer" onSubmit={event => { event.preventDefault(); proceed(Boolean(cli)) }}>
      {cli
        ? <input
            ref={input}
            className="bs-restored__input"
            aria-label={`Message ${label} to continue`}
            placeholder={checking ? 'Checking for a running shell…' : `Press Enter to continue with ${label}, or type a message first`}
            value={message}
            disabled={checking}
            onChange={event => setMessage(event.target.value)}
            onFocus={() => setInsert(true)}
            spellCheck={false}
            autoComplete="off"
          />
        : <span className="bs-restored__note" style={{ flex: 1 }}>The previous shell is stopped.</span>}
      {cli && <button type="submit" className="bs-restored__primary" disabled={checking} title={command ? `Starts a shell and runs: ${abbreviatePathsIn(command)}${message.trim() ? ' (with your message)' : ''}` : undefined}>
        Continue {label}
      </button>}
      <button type="button" disabled={checking} onClick={() => proceed(false)} title="Start an empty shell in this folder; the conversation stays in History">New shell</button>
    </form>
    {cli && <p className="bs-restored__foot">
      {sessionId ? 'Continues this exact conversation.' : `No conversation found to show; Continue reopens your latest ${label} conversation in this folder.`}
      {' '}Nothing has started. To skip this step, turn on “Continue agent sessions automatically” in Settings → Sessions.
    </p>}
  </div>
}
