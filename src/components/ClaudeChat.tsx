import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

type Frame = any

interface ClaudeChatProps {
  projectId: string
  cwd: string
  sessionId: string
}

type StartStatus = 'pending' | 'started' | 'frame' | 'failed'

export function ClaudeChat({ projectId, cwd, sessionId }: ClaudeChatProps) {
  const [frames, setFrames] = useState<Frame[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<StartStatus>('pending')
  const [stderrCount, setStderrCount] = useState(0)

  useEffect(() => {
    console.info('[ClaudeChat] starting', { projectId, cwd, sessionId })
    let offEvent: (() => void) | null = null
    let offRaw: (() => void) | null = null
    let offStderr: (() => void) | null = null
    let cancelled = false
    ;(async () => {
      let sid = sessionId
      // Defensive: post-W1 every Project carries a session id, but if it's
      // missing we fall back to projects_get to read the auto-minted UUID.
      if (!sid) {
        try {
          const proj = await invoke<{ claudeSessionId: string }>('projects_get', { id: projectId })
          sid = proj.claudeSessionId
        } catch (e) {
          console.error('projects_get failed', e)
        }
      }
      if (cancelled) return
      try {
        await invoke('claude_start', { projectId, cwd, sessionId: sid })
        if (!cancelled) setStatus('started')
      } catch (e) {
        console.error('claude_start failed', e)
        if (!cancelled) {
          setStatus('failed')
          setFrames(f => [...f, { _kind: 'stderr', line: 'claude_start failed: ' + String(e) }])
          setStderrCount(c => c + 1)
        }
      }
      if (cancelled) return
      offEvent = await listen<Frame>(`claude_event:${projectId}`, e => {
        setFrames(f => [...f, e.payload])
        setStatus(s => (s === 'failed' ? s : 'frame'))
      })
      offRaw = await listen<string>(`claude_event_raw:${projectId}`, e => {
        setFrames(f => [...f, { _kind: 'raw', line: String(e.payload) }])
      })
      offStderr = await listen<string>(`claude_stderr:${projectId}`, e => {
        setFrames(f => [...f, { _kind: 'stderr', line: String(e.payload) }])
        setStderrCount(c => c + 1)
      })
    })()
    return () => {
      cancelled = true
      offEvent?.()
      offRaw?.()
      offStderr?.()
      // Phase 6 manages claude lifecycles — do NOT auto-kill on unmount.
    }
  }, [projectId, cwd, sessionId])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    setFrames(f => [...f, { _local: true, role: 'user', text }])
    setInput('')
    try { await invoke('claude_send', { projectId, text }) } finally { setBusy(false) }
  }

  // Status dot: red if start failed or any stderr seen; yellow if started but
  // no assistant frame yet; green once a frame has arrived. These are
  // semantic state markers (syntax-construct usage of tokyonight tokens).
  const dotColor =
    status === 'failed' || stderrCount > 0 ? 'var(--bs-red)'
    : status === 'frame' ? 'var(--bs-green)'
    : 'var(--bs-yellow)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderTop: '1px solid var(--bs-border)' }}>
      <div style={{
        height: 24, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11, color: 'var(--bs-fg)', opacity: 0.7,
        borderBottom: '1px solid var(--bs-border)', background: 'var(--bs-bg-elev)',
      }}>
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          background: dotColor, flexShrink: 0,
        }} />
        <span>claude · {projectId}</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, fontSize: 12, lineHeight: 1.5 }}>
        {frames.map((f, i) => {
          const style: React.CSSProperties = { margin: '0 0 8px 0', whiteSpace: 'pre-wrap' }
          if (f?._kind === 'stderr') { style.color = 'var(--bs-red)'; style.opacity = 0.8 }
          else if (f?._kind === 'raw') { style.color = 'var(--bs-yellow)'; style.opacity = 0.8 }
          return <pre key={i} style={style}>{renderFrame(f)}</pre>
        })}
      </div>
      <form onSubmit={e => { e.preventDefault(); send() }} style={{ display: 'flex', gap: 8, padding: 8, borderTop: '1px solid var(--bs-border)' }}>
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="ask claude" disabled={busy}
          style={{ flex: 1, background: 'var(--bs-bg-elev)', color: 'var(--bs-fg)', border: '1px solid var(--bs-border)', padding: '6px 8px', fontFamily: 'inherit' }} />
        <button type="submit" disabled={busy} style={{ background: 'var(--bs-blue)', color: 'var(--bs-bg-dark)', border: 'none', padding: '6px 12px', fontFamily: 'inherit', cursor: 'pointer' }}>send</button>
      </form>
    </div>
  )
}

function renderFrame(f: any): string {
  if (f?._local) return `> ${f.text}`
  if (f?._kind === 'stderr') return `[stderr] ${f.line}`
  if (f?._kind === 'raw') return `[raw] ${f.line}`
  if (f?.type === 'assistant' && f?.message?.content) {
    const parts = Array.isArray(f.message.content) ? f.message.content : []
    return parts.map((p: any) => p?.type === 'text' ? p.text : JSON.stringify(p)).join('\n')
  }
  if (f?.type === 'system') return `[system] ${f?.subtype ?? ''}`
  if (f?.type === 'result') return `[result] ${f?.subtype ?? ''}`
  return JSON.stringify(f).slice(0, 400)
}
