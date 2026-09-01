import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { invoke } from '@tauri-apps/api/core'
import { safeListen } from '../lib/safeListen'
import { getActivePalette, useThemePaletteId } from '../state/theme'
import 'xterm/css/xterm.css'

// RV1 — Terminal is now a CONTROLLED leaf owned by the termPanes store.
//
// The pty lifecycle is LIFTED: this component still spawns its pty on mount
// (a fresh leaf has none yet) and reports the id back via onSpawn, but it
// deliberately does NOT kill the pty on unmount — the store's closePane()
// owns the kill. That's what lets a split/tab reflow re-parent the same
// paneId subtree without respawning the shell (persistence is the point).
//
// Keyed by paneId (NOT active project id) in the parent so React preserves
// the DOM + xterm instance across layout changes.

export function Terminal({
  paneId,
  cwd,
  onSpawn,
  focused,
  insert,
}: {
  paneId: string
  cwd: string
  onSpawn: (paneId: string, ptyId: number) => void
  focused: boolean
  insert: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const ptyIdRef = useRef<number | null>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const paletteId = useThemePaletteId()

  useEffect(() => {
    const palette = getActivePalette()
    const xterm = new XTerm({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      theme: palette
        ? {
            background: palette.background,
            foreground: palette.foreground,
            cursor: palette.cursor,
            selectionBackground: palette.selectionBackground,
            selectionForeground: palette.selectionForeground,
            black: palette.black,
            red: palette.red,
            green: palette.green,
            yellow: palette.yellow,
            blue: palette.blue,
            magenta: palette.magenta,
            cyan: palette.cyan,
            white: palette.white,
            brightBlack: palette.brightBlack,
            brightRed: palette.brightRed,
            brightGreen: palette.brightGreen,
            brightYellow: palette.brightYellow,
            brightBlue: palette.brightBlue,
            brightMagenta: palette.brightMagenta,
            brightCyan: palette.brightCyan,
            brightWhite: palette.brightWhite,
          }
        : { background: '#1f2335', foreground: '#c0caf5', cursor: '#c0caf5' },
      convertEol: true,
      cursorBlink: true,
    })
    xtermRef.current = xterm
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
        // Aborted before we armed listeners — DO kill here, since the store
        // never learned this ptyId (onSpawn hasn't fired). Prevents an orphan.
        invoke('pty_kill', { id }).catch(() => {})
        ptyIdRef.current = null
        return
      }
      onSpawn(paneId, id)
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
        // Code-bqz: a queued RO callback can fire after the effect aborts and
        // xterm.dispose() ran (reflow/skin-flip unmount). fit.fit() then reads
        // the torn-down renderer -> "undefined is not an object (evaluating
        // this._renderer.value.dimensions)". Guard on liveness before measuring.
        if (signal.aborted || xtermRef.current === null) return
        try {
          fit.fit()
        } catch { return }
        if (ptyIdRef.current !== null) invoke('pty_resize', { id: ptyIdRef.current, cols: xterm.cols, rows: xterm.rows })
      })
      ro.observe(hostRef.current!)
    })()

    return () => {
      ac.abort()
      ro?.disconnect()
      xterm.dispose()
      xtermRef.current = null
      // NOTE: no pty_kill here. The store owns the kill in closePane(). A
      // reflow unmount must not tear the shell down — that's persistence.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-apply palette when the user switches themes without remounting the terminal.
  useEffect(() => {
    const xterm = xtermRef.current
    if (!xterm) return
    const palette = getActivePalette()
    xterm.options.theme = palette
      ? {
          background: palette.background,
          foreground: palette.foreground,
          cursor: palette.cursor,
          selectionBackground: palette.selectionBackground,
          selectionForeground: palette.selectionForeground,
          black: palette.black,
          red: palette.red,
          green: palette.green,
          yellow: palette.yellow,
          blue: palette.blue,
          magenta: palette.magenta,
          cyan: palette.cyan,
          white: palette.white,
          brightBlack: palette.brightBlack,
          brightRed: palette.brightRed,
          brightGreen: palette.brightGreen,
          brightYellow: palette.brightYellow,
          brightBlue: palette.brightBlue,
          brightMagenta: palette.brightMagenta,
          brightCyan: palette.brightCyan,
          brightWhite: palette.brightWhite,
        }
      : { background: '#1f2335', foreground: '#c0caf5', cursor: '#c0caf5' }
  }, [paletteId])

  // Route keyboard to this xterm only when focused AND in insert mode.
  useEffect(() => {
    if (focused && insert && hostRef.current) {
      const ta = hostRef.current.querySelector('.xterm textarea') as HTMLTextAreaElement | null
      ta?.focus()
    }
  }, [focused, insert])

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
