import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

type Frame = any

interface ClaudeChatProps {
  projectId: string
  cwd: string
  sessionId: string
}

export function ClaudeChat({ projectId, cwd, sessionId }: ClaudeChatProps) {
  const [frames, setFrames] = useState<Frame[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let off: (() => void) | null = null
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
      } catch (e) {
        console.error('claude_start failed', e)
      }
      if (cancelled) return
      off = await listen<Frame>(`claude_event:${projectId}`, e => setFrames(f => [...f, e.payload]))
    })()
    return () => {
      cancelled = true
      off?.()
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderTop: '1px solid var(--border)' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, fontSize: 12, lineHeight: 1.5 }}>
        {frames.map((f, i) => <pre key={i} style={{ margin: '0 0 8px 0', whiteSpace: 'pre-wrap' }}>{renderFrame(f)}</pre>)}
      </div>
      <form onSubmit={e => { e.preventDefault(); send() }} style={{ display: 'flex', gap: 8, padding: 8, borderTop: '1px solid var(--border)' }}>
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="ask claude" disabled={busy}
          style={{ flex: 1, background: 'var(--bg-elev)', color: 'var(--fg)', border: '1px solid var(--border)', padding: '6px 8px', fontFamily: 'inherit' }} />
        <button type="submit" disabled={busy} style={{ background: 'var(--accent)', color: '#1a1b26', border: 'none', padding: '6px 12px', fontFamily: 'inherit', cursor: 'pointer' }}>send</button>
      </form>
    </div>
  )
}

function renderFrame(f: any): string {
  if (f?._local) return `> ${f.text}`
  if (f?.type === 'assistant' && f?.message?.content) {
    const parts = Array.isArray(f.message.content) ? f.message.content : []
    return parts.map((p: any) => p?.type === 'text' ? p.text : JSON.stringify(p)).join('\n')
  }
  if (f?.type === 'system') return `[system] ${f?.subtype ?? ''}`
  if (f?.type === 'result') return `[result] ${f?.subtype ?? ''}`
  return JSON.stringify(f).slice(0, 400)
}
