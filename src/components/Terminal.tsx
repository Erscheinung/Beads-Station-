import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import 'xterm/css/xterm.css'

export function Terminal({ cwd }: { cwd: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
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

    let id: number | null = null
    let unlistenData: (() => void) | null = null
    let unlistenExit: (() => void) | null = null
    let ro: ResizeObserver | null = null

    ;(async () => {
      id = await invoke<number>('pty_spawn', { cwd })
      unlistenData = await listen<{ id: number; data: string }>(
        `pty_data:${id}`,
        (e) => xterm.write(e.payload.data),
      )
      unlistenExit = await listen<{ id: number }>(
        `pty_exit:${id}`,
        () => xterm.write('\r\n[process exited]\r\n'),
      )
      xterm.onData((d) => {
        if (id !== null) invoke('pty_write', { id, data: d })
      })
      ro = new ResizeObserver(() => {
        fit.fit()
        if (id !== null) invoke('pty_resize', { id, cols: xterm.cols, rows: xterm.rows })
      })
      ro.observe(hostRef.current!)
    })()

    return () => {
      ro?.disconnect()
      unlistenData?.()
      unlistenExit?.()
      if (id !== null) invoke('pty_kill', { id }).catch(() => {})
      xterm.dispose()
    }
  }, [cwd])
  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
