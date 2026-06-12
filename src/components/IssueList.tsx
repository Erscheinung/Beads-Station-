import { useEffect, useState } from 'react'
import type { Issue } from '../types/issue'
import { bdReady } from '../types/issue'

export function IssueList({ repoPath }: { repoPath: string }) {
  const [issues, setIssues] = useState<Issue[]>([])
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { bdReady(repoPath).then(setIssues).catch(e => setErr(String(e))) }, [repoPath])
  if (err) return <pre style={{ color: '#f7768e', padding: 12 }}>{err}</pre>
  return (
    <div style={{ padding: 12, overflowY: 'auto', height: '100%' }}>
      <div style={{ fontSize: 11, color: 'var(--fg)', opacity: 0.5, marginBottom: 8 }}>READY ({issues.length})</div>
      {issues.map(i => (
        <div key={i.id} style={{ padding: '6px 8px', borderLeft: '2px solid var(--accent)', marginBottom: 4, fontSize: 12 }}>
          <div style={{ opacity: 0.6 }}>{i.id} · P{i.priority} · {i.issue_type}</div>
          <div>{i.title}</div>
        </div>
      ))}
    </div>
  )
}
