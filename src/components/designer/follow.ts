// Following a session file as an agent writes to it (Code-7xc.9). The Rust side
// answers a cheap stamp (modified time and size); the conversation is parsed
// again only when the stamp changed. Reading starts nothing and costs no tokens.

import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { readTranscript, relativeTime, type Transcript, type TranscriptProvider, type TranscriptTurn } from './transcripts'

export const FOLLOW_POLL_MS = 3_000
/** A session file written this recently counts as running. */
export const RUNNING_WINDOW_MS = 20_000

export interface TranscriptStamp { modifiedMs: number; bytes: number }

export function readStamp(workspacePath: string, provider: TranscriptProvider, sessionId: string): Promise<TranscriptStamp | null> {
  return invoke<TranscriptStamp | null>('transcript_stamp', { workspacePath, provider, sessionId })
}

export function isRunningSession(modifiedMs: number | null | undefined, now = Date.now()): boolean {
  return Boolean(modifiedMs) && now - modifiedMs! >= 0 && now - modifiedMs! <= RUNNING_WINDOW_MS
}

/** "last turn 2m ago", from the newest turn's own time, else from the file's. Null when neither is known. */
export function lastTurnLabel(turns: TranscriptTurn[], modifiedMs: number | null | undefined, now = Date.now()): string | null {
  const stamped = [...turns].reverse().find(turn => turn.at && !Number.isNaN(new Date(turn.at).getTime()))
  const at = stamped ? new Date(stamped.at!).getTime() : modifiedMs || 0
  return at > 1_000_000 ? `last turn ${relativeTime(at, now)}` : null
}

/**
 * How many new turns arrived while the reader was scrolled away from the end.
 * Following the end shows them at once, so nothing is pending; the first read
 * of a session (previous null) is never "new".
 */
export function pendingNewTurns(previous: number | null, next: number, atEnd: boolean, pending: number): number {
  if (previous === null || atEnd) return atEnd ? 0 : pending
  return next > previous ? pending + (next - previous) : pending
}

export function nearEnd(element: { scrollHeight: number; scrollTop: number; clientHeight: number }, slack = 80): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < slack
}

/**
 * The conversation of one session, kept current while `enabled`. Polls only
 * while the window is in front and re-reads only when the file changed.
 */
export function useSessionFollow({ cwd, provider, sessionId, enabled = true, intervalMs = FOLLOW_POLL_MS }: {
  cwd: string
  provider: TranscriptProvider | null | undefined
  sessionId: string | null | undefined
  enabled?: boolean
  intervalMs?: number
}) {
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [stamp, setStamp] = useState<TranscriptStamp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastKey = useRef<string | undefined>(undefined)

  useEffect(() => {
    setTranscript(null); setStamp(null); setError(null)
    lastKey.current = undefined
    if (!enabled || !provider || !sessionId) return
    let cancelled = false
    let busy = false
    const tick = async () => {
      if (busy || cancelled) return
      busy = true
      try {
        const next = await Promise.resolve(readStamp(cwd, provider, sessionId)).catch(() => null)
        if (cancelled) return
        const key = next ? `${next.modifiedMs}:${next.bytes}` : 'unknown'
        // Without a stamp (file gone, older backend) read once, then stop re-reading.
        if (key === lastKey.current) return
        lastKey.current = key
        const result = await readTranscript(cwd, provider, sessionId)
        if (cancelled) return
        if (next) setStamp(next)
        if (result?.turns) { setTranscript(result); setError(null) }
      } catch (failure) {
        if (!cancelled) setError(String(failure))
      } finally { busy = false }
    }
    void tick()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void tick() }, intervalMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [cwd, provider, sessionId, enabled, intervalMs])

  return { transcript, stamp, error }
}

/** A clock that ticks so "running" and "2m ago" fade without a data change. */
export function useNow(intervalMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
