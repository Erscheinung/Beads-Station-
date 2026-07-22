import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { invoke } from '@tauri-apps/api/core'
import { safeListen } from '../lib/safeListen'
import 'xterm/css/xterm.css'

export function Terminal({ cwd }: { cwd: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const ptyIdRef = useRef<number | null>(null)
  useEffect(() => {
    const xterm = new XTerm({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      /* mirrors --bs-bg / --bs-fg — xterm reads at instantiation, doesn't observe CSS vars */
      theme: { background: '#1f2335', foreground: '#c0caf5', cursor: '#c0caf5' },
      convertEol: true,
      cursorBlink: true,
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.loadAddon(new WebLinksAddon())
    xterm.open(hostRef.current!)
    fit.fit()

    const ac = new AbortController()
    const { signal } = ac
    let ro: ResizeObserver | null = null

    ;(async () => {
      const id = await invoke<number>('pty_spawn', { cwd })
      ptyIdRef.current = id
      if (signal.aborted) {
        invoke('pty_kill', { id }).catch(() => {})
        ptyIdRef.current = null
        return
      }
      await safeListen<{ id: number; data: string }>(
        `pty_data:${id}`,
        (e) => xterm.write(e.payload.data),
        signal,
      )
      await safeListen<{ id: number }>(
        `pty_exit:${id}`,
        () => xterm.write('\r\n[process exited]\r\n'),
        signal,
      )
      xterm.onData((d) => {
        if (ptyIdRef.current !== null) invoke('pty_write', { id: ptyIdRef.current, data: d })
      })
      ro = new ResizeObserver(() => {
        fit.fit()
        if (ptyIdRef.current !== null) invoke('pty_resize', { id: ptyIdRef.current, cols: xterm.cols, rows: xterm.rows })
      })
      ro.observe(hostRef.current!)
    })()

    return () => {
      ac.abort()
      ro?.disconnect()
      xterm.dispose()
      if (ptyIdRef.current !== null) {
        invoke('pty_kill', { id: ptyIdRef.current }).catch(() => {})
        ptyIdRef.current = null
      }
    }
  }, [cwd])
  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
