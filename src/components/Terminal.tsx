import { useEffect, useRef, useState } from 'react'
import { disposeTerminalSession, getTerminalSession, type TerminalSession } from '../lib/terminalSessions'
import { useThemePaletteId } from '../state/theme'
import { useTerminalAppearance } from '../state/terminalAppearance'
import 'xterm/css/xterm.css'

/** A view of a session. Unmounting the view never replaces its shell or screen. */
export function Terminal({ paneId, cwd, onSpawn, focused, insert }: {
  paneId: string
  cwd: string
  onSpawn: (paneId: string, ptyId: number) => void
  focused: boolean
  insert: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<TerminalSession | null>(null)
  const [phase, setPhase] = useState('starting')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const paletteId = useThemePaletteId()
  const appearance = useTerminalAppearance()

  useEffect(() => {
    const element = host.current!
    const session = getTerminalSession(paneId, cwd, onSpawn)
    sessionRef.current = session
    session.attach(element)
    const update = () => { setPhase(session.phase); setError(session.error) }
    update()
    const unsubscribe = session.subscribe(update)
    const resize = new ResizeObserver(() => session.resize())
    resize.observe(element)
    return () => {
      unsubscribe()
      resize.disconnect()
      session.detach(element)
      sessionRef.current = null
    }
  }, [paneId, cwd, onSpawn, attempt])
  useEffect(() => { sessionRef.current?.applyTheme() }, [paletteId])
  useEffect(() => { sessionRef.current?.applyAppearance() }, [appearance])
  useEffect(() => {
    if (focused && insert) sessionRef.current?.terminal.focus()
  }, [focused, insert, phase, attempt])

  return <div data-terminal-pane={paneId} data-terminal-phase={phase} style={{ width: '100%', height: '100%', position: 'relative' }}>
    <div ref={host} style={{ width: '100%', height: '100%' }} />
    {(phase === 'error' || phase === 'exited') && <div role={phase === 'error' ? 'alert' : 'status'} style={{ position: 'absolute', bottom: 8, left: 8, right: 8, padding: 8, background: 'var(--bs-bg-elev)', color: 'var(--bs-fg)', fontSize: 12 }}>
      {error ?? 'Shell exited.'} <button onClick={() => { disposeTerminalSession(paneId); setAttempt(n => n + 1) }}>Restart terminal</button>
    </div>}
  </div>
}
