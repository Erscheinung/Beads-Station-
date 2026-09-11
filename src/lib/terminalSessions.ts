// UI-lifetime terminal sessions. React attaches/detaches their DOM; only an
// explicit pane/workspace close disposes xterm and its native process.
import { Terminal as XTerm } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { invoke } from '@tauri-apps/api/core'
import { safeListen as listen } from './listenerRegistry'
import { getActivePalette } from '../state/theme'
import { getTerminalAppearance, subscribeTerminalAppearance } from '../state/terminalAppearance'
import { matchedCommand } from '../state/commands'

type Phase = 'starting' | 'running' | 'exited' | 'error'
export class TerminalSession {
  readonly element = document.createElement('div')
  readonly terminal = new XTerm({ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, cursorBlink: true, scrollback: 3000 })
  readonly fit = new FitAddon()
  readonly ready: Promise<void>
  id: number | null = null
  phase: Phase = 'starting'
  error: string | null = null
  private nativeSize = ''
  private closed = false
  private releases: Array<() => void> = []
  private listeners = new Set<() => void>()
  private input: Promise<unknown> = Promise.resolve()
  // WebKit can retain an xterm canvas' old backing store when React moves a
  // session view between split-tree hosts. Repaint after the new host has had
  // a layout frame; this is view work only and never replaces the PTY.
  private attachment = 0
  private repaintFrame: number | null = null

  constructor(readonly paneId: string, cwd: string, onSpawn: (paneId: string, id: number) => void) {
    this.element.style.cssText = 'width:100%;height:100%;'
    this.terminal.loadAddon(this.fit)
    this.terminal.loadAddon(new WebLinksAddon())
    this.terminal.open(this.element)
    this.terminal.attachCustomKeyEventHandler(e => !matchedCommand(e))
    this.applyTheme()
    this.applyAppearance()
    const onData = this.terminal.onData(data => {
      if (this.phase !== 'running' || this.closed) return
      this.input = this.input.then(() => {
        if (!this.closed && this.id !== null) return invoke('pty_write', { id: this.id, data })
      }).catch(error => this.fail(error))
    })
    this.releases.push(() => onData.dispose())
    // Detached tabs retain live terminals too; apply preferences without a React remount.
    this.releases.push(subscribeTerminalAppearance(() => this.applyAppearance()))
    this.ready = this.start(cwd, onSpawn)
  }

  private notify() { this.listeners.forEach(listener => listener()) }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private fail(error: unknown) {
    if (this.closed) return
    this.error = String(error)
    this.phase = 'error'
    this.notify()
  }

  private async start(cwd: string, onSpawn: (paneId: string, id: number) => void) {
    // An opaque channel is known BEFORE native spawn. Failed subscription must
    // prevent spawning; a shell with no output listener is not usable.
    const eventKey = crypto.randomUUID()
    try {
      const output = await listen<{ id: number; data: string }>(`pty_data:${eventKey}`, event => {
        if (!this.closed) this.terminal.write(event.payload.data)
      })
      if (this.closed) { output(); return }
      this.releases.push(output)
      const exit = await listen<{ id: number }>(`pty_exit:${eventKey}`, () => {
        if (this.closed) return
        this.phase = 'exited'
        this.terminal.write('\r\n[process exited]\r\n')
        this.notify()
      })
      if (this.closed) { exit(); return }
      this.releases.push(exit)
      this.nativeSize = `${this.terminal.cols}:${this.terminal.rows}`
      const id = await invoke<number>('pty_spawn', { cwd, eventKey, cols: this.terminal.cols, rows: this.terminal.rows })
      if (this.closed) { await invoke('pty_kill', { id }); return }
      this.id = id
      // A fast-exiting shell can emit exit before spawn's response arrives.
      if (this.phase === 'starting') this.phase = 'running'
      onSpawn(this.paneId, id)
      this.resize()
      this.notify()
    } catch (error) {
      this.releases.splice(0).forEach(release => release())
      this.fail(error)
    }
  }

  attach(host: HTMLElement) {
    const attachment = ++this.attachment
    host.appendChild(this.element)
    this.applyTheme()
    this.applyAppearance()
    this.resize()
    this.repaint(attachment)
    this.scheduleRepaint(attachment)
  }
  detach(host: HTMLElement) {
    if (this.element.parentElement === host) this.element.remove()
    this.attachment++
    if (this.repaintFrame !== null) {
      cancelAnimationFrame(this.repaintFrame)
      this.repaintFrame = null
    }
  }
  /** Repaint a retained xterm screen after moving it to a new React host. */
  repaint(attachment = this.attachment) {
    if (this.closed || attachment !== this.attachment || !this.element.isConnected) return
    try { this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1)) } catch { /* disposed during a view transition */ }
  }
  private scheduleRepaint(attachment: number) {
    // The immediate refresh covers browsers which paint synchronously. A
    // second layout frame covers WKWebView after a split/tab host changes size.
    this.repaintFrame = requestAnimationFrame(() => {
      if (this.closed || attachment !== this.attachment) return
      this.repaintFrame = requestAnimationFrame(() => {
        if (this.closed || attachment !== this.attachment) return
        this.repaintFrame = null
        this.resize()
        this.repaint(attachment)
      })
    })
  }
  applyTheme() {
    this.terminal.options.theme = getActivePalette() ?? { background: '#1f2335', foreground: '#c0caf5', cursor: '#c0caf5' }
  }
  applyAppearance() {
    const appearance = getTerminalAppearance()
    this.terminal.options.fontFamily = `${appearance.fontFamily}, monospace`
    this.terminal.options.fontSize = appearance.fontSize
    this.terminal.options.lineHeight = appearance.lineHeight
    this.terminal.options.cursorStyle = appearance.cursorStyle
    this.terminal.options.cursorBlink = appearance.cursorBlink
    this.terminal.options.scrollback = appearance.scrollback
    this.resize()
  }
  resize() {
    if (this.closed || !this.element.isConnected || !this.element.clientWidth || !this.element.clientHeight) return
    try { this.fit.fit() } catch { return }
    const size = `${this.terminal.cols}:${this.terminal.rows}`
    if (this.id !== null && this.phase === 'running' && this.nativeSize !== size) {
      this.nativeSize = size
      void invoke('pty_resize', { id: this.id, cols: this.terminal.cols, rows: this.terminal.rows }).catch(error => this.fail(error))
    }
  }
  dispose() {
    if (this.closed) return
    this.closed = true
    this.attachment++
    if (this.repaintFrame !== null) cancelAnimationFrame(this.repaintFrame)
    this.releases.splice(0).forEach(release => release())
    this.listeners.clear()
    this.terminal.dispose()
    this.element.remove()
    if (this.id !== null) void invoke('pty_kill', { id: this.id }).catch(() => {})
  }
}

const sessions = new Map<string, TerminalSession>()
export function getTerminalSession(paneId: string, cwd: string, onSpawn: (paneId: string, id: number) => void): TerminalSession {
  let session = sessions.get(paneId)
  if (!session) { session = new TerminalSession(paneId, cwd, onSpawn); sessions.set(paneId, session) }
  return session
}
export function disposeTerminalSession(paneId: string) {
  sessions.get(paneId)?.dispose()
  sessions.delete(paneId)
}

function onDispose(event: Event) {
  const paneId = (event as CustomEvent<{ paneId: string }>).detail.paneId
  // Claim process cleanup so callers do not send a second kill for this ID.
  if (sessions.has(paneId)) event.preventDefault()
  disposeTerminalSession(paneId)
}
window.addEventListener('terminal:dispose', onDispose)
// A module replacement is a development restart, not ordinary React navigation.
if (import.meta.hot) import.meta.hot.dispose(() => {
  window.removeEventListener('terminal:dispose', onDispose)
  for (const session of sessions.values()) session.dispose()
  sessions.clear()
})
