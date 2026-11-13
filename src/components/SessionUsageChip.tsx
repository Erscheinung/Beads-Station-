// Session usage only: how big the agent session running in this pane is.
// Read from the CLI's own session file; it starts nothing and needs no tokens.

import { useEffect, useState } from 'react'
import { readTranscript, usageLine, type TranscriptProvider, type TranscriptUsage } from './designer/transcripts'

export function SessionUsageChip({ workspacePath, provider, sessionId }: { workspacePath: string; provider: TranscriptProvider; sessionId: string }) {
  const [usage, setUsage] = useState<TranscriptUsage | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      if (document.visibilityState !== 'visible') return
      Promise.resolve(readTranscript(workspacePath, provider, sessionId)).then(t => { if (!cancelled) setUsage(t?.usage ?? null) }).catch(() => { if (!cancelled) setUsage(null) })
    }
    load()
    const timer = setInterval(load, 20_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [workspacePath, provider, sessionId])
  if (!usage) return null
  return <span className="bs-session-usage" data-testid="session-usage" title="Tokens used by this session so far, read from the session file. Cached input is billed differently.">{usageLine(usage)}</span>
}
