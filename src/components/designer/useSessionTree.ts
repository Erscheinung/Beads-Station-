// Polls the agents' own session files for the Agents and Timeline views.
// Read-only and light: one listing every few seconds, only while the window is
// in front and the view is mounted. It starts nothing.

import { useEffect, useMemo, useState } from 'react'
import { listTranscripts, type TranscriptSummary } from './transcripts'
import { buildSessionTree, type SessionNode } from './activity'

const POLL_MS = 6_000

export function useSessionTree(workspacePath: string, beadIds: string[]): { tree: SessionNode[]; loaded: boolean; error: string | null } {
  const [list, setList] = useState<TranscriptSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!workspacePath) { setList([]); return }
    let cancelled = false
    const load = () => {
      if (document.visibilityState !== 'visible') return
      listTranscripts(workspacePath)
        .then(next => { if (cancelled) return; setNow(Date.now()); setError(null); setList(cur => JSON.stringify(cur) === JSON.stringify(next) ? cur : next) })
        .catch(failure => { if (!cancelled) setError(String(failure)) })
    }
    setList(null)
    load()
    const timer = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [workspacePath])
  const key = beadIds.join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tree = useMemo(() => buildSessionTree(list ?? [], beadIds, now), [list, now, key])
  return { tree, loaded: list !== null, error }
}
