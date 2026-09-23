// UI-lifetime terminal sessions. React attaches/detaches their DOM; only an
// explicit pane/workspace close disposes xterm and its native process.
import { Terminal as XTerm, type IMarker } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { invoke } from '@tauri-apps/api/core'
import { safeListen as listen } from './listenerRegistry'
import { getActivePalette, subscribeTheme } from '../state/theme'
import { getTerminalAppearance, subscribeTerminalAppearance } from '../state/terminalAppearance'
import { matchedCommand } from '../state/commands'

type Phase = 'starting' | 'running' | 'exited' | 'error'

interface ViewportState {
  buffer: 'normal' | 'alternate'
  followOutput: boolean
  marker: IMarker | null
  fallbackLine: number
}

interface NativePtySnapshot {
  id: number
  pid: number | null
  cols: number
  rows: number
}

export interface TerminalLifecycleSnapshot {
  paneId: string
  ptyId: number | null
  pid: number | null
  phase: Phase
  attached: boolean
  container: { x: number; y: number; width: number; height: number } | null
  font: { family: string; size: number; lineHeight: number }
  terminal: { cols: number; rows: number }
  native: { cols: number; rows: number } | null
  viewport: { buffer: 'normal' | 'alternate'; line: number; base: number; followOutput: boolean }
  activeElement: string | null
  ownsInputFocus: boolean
}

export interface PersistedTerminalScreen {
  lines: string[]
  cols: number
  rows: number
  buffer: 'normal' | 'alternate'
  cursorX: number
  cursorY: number
  capturedAt: number
}

const ESC = '\u001b'

// Keep a detached xterm screen connected while React re-parents its view.
// xterm.js pauses its renderer when the observed screen element leaves the
// document. A split/tab transition can remove and reinsert that element in a
// single render pass, which WebKit may not report as a fresh IntersectionObserver
// transition; the retained canvas then stays blank even though its PTY lives.
// The parking host remains in the viewport geometrically (but transparent and
// inaccessible), so xterm keeps its renderer live until the next attach.
let parkingHost: HTMLDivElement | null = null
function getParkingHost(): HTMLDivElement | null {
  if (typeof document === 'undefined' || !document.body) return null
  if (!parkingHost) {
    parkingHost = document.createElement('div')
    parkingHost.dataset.bsTerminalParking = 'true'
    parkingHost.setAttribute('aria-hidden', 'true')
    parkingHost.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;'
  }
  if (!parkingHost.isConnected) document.body.appendChild(parkingHost)
  return parkingHost
}

function normalizeSgrParams(params: string): string {
  // Neovim emits ISO-8613-6 colon-form extended colours (for example,
  // `38:2:200:211:245`). xterm.js 5.3's parser expects the semicolon form
  // for this sequence and otherwise shifts the RGB components left, which
  // turns a normal LazyVim screen into a uniformly green/yellow canvas.
  return params.split(';').map(part => {
    const values = part.split(':')
    const code = Number(values[0])
    const mode = values[1]
    const isExtended = code === 38 || code === 48 || code === 58
    const channels = values.slice(2)
    const validChannel = (value: string) => /^\d{1,3}$/.test(value) && Number(value) <= 255
    if (isExtended && mode === '2' && channels.length === 3 && channels.every(validChannel)) {
      return `${values[0]};2;${channels.join(';')}`
    }
    if (isExtended && mode === '5' && channels.length === 1 && validChannel(channels[0])) {
      return `${values[0]};5;${channels[0]}`
    }
    return part
  }).join(';')
}

/**
 * Normalize Neovim's colon-form SGR extended colours without buffering
 * ordinary PTY output. The PTY can split an escape sequence between reads, so
 * retain only an incomplete CSI sequence and flush it verbatim on exit.
 */
export class SgrColorNormalizer {
  private pending = ''

  push(data: string): string {
    const input = this.pending + data
    this.pending = ''
    let output = ''
    let cursor = 0

    while (cursor < input.length) {
      const start = input.indexOf(`${ESC}[`, cursor)
      if (start === -1) {
        output += input.slice(cursor)
        break
      }
      output += input.slice(cursor, start)
      let final = start + 2
      while (final < input.length) {
        const code = input.charCodeAt(final)
        if (code >= 0x40 && code <= 0x7e) break
        final++
      }
      if (final >= input.length) {
        this.pending = input.slice(start)
        break
      }
      const sequence = input.slice(start, final + 1)
      if (input[final] === 'm') {
        const params = input.slice(start + 2, final)
        output += /^[0-9:;]*$/.test(params) ? `${ESC}[${normalizeSgrParams(params)}m` : sequence
      } else {
        output += sequence
      }
      cursor = final + 1
    }
    return output
  }

  finish(): string {
    const tail = this.pending
    this.pending = ''
    return tail
  }
}

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
  private readonly outputNormalizer = new SgrColorNormalizer()
  // WebKit can retain an xterm canvas' old backing store when React moves a
  // session view between split-tree hosts. Repaint after the new host has had
  // a layout frame; this is view work only and never replaces the PTY.
  private attachment = 0
  private repaintFrame: number | null = null
  private attachedHost: HTMLElement | null = null
  private restoringViewport = false
  // Follow/read intent changes only on user gestures. Output-driven scroll
  // events (scrollback trimming, a TUI clearing scrollback with ESC[3J and
  // reprinting its transcript) must not silently re-enable follow-bottom while
  // the user is reading history.
  private userScrollUntil = 0
  private pointerScrolling = false
  private viewport: ViewportState = { buffer: 'normal', followOutput: true, marker: null, fallbackLine: 0 }
  private screenTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly paneId: string,
    cwd: string,
    onSpawn: (paneId: string, id: number) => void,
    private readonly onScreen?: (paneId: string, screen: PersistedTerminalScreen) => void,
  ) {
    this.element.style.cssText = 'width:100%;height:100%;'
    this.terminal.loadAddon(this.fit)
    this.terminal.loadAddon(new WebLinksAddon())
    this.terminal.open(this.element)
    this.terminal.attachCustomKeyEventHandler(e => !matchedCommand(e))
    this.applyTheme()
    this.applyAppearance()
    const onData = this.terminal.onData(data => {
      if (this.phase !== 'running' || this.closed) return
      // xterm's scrollOnUserInput snaps typing back to the live prompt; adopt
      // that as the new intent so the next write does not scroll away again.
      if (this.terminal.options.scrollOnUserInput !== false) this.followLiveOutput()
      this.input = this.input.then(() => {
        if (!this.closed && this.id !== null) return invoke('pty_write', { id: this.id, data })
      }).catch(error => this.fail(error))
    })
    this.releases.push(() => onData.dispose())
    const onScroll = this.terminal.onScroll(() => {
      if (!this.restoringViewport && this.userIsScrolling()) this.captureViewport()
    })
    this.releases.push(() => onScroll.dispose())
    this.trackUserScrollIntent()
    const onBufferChange = this.terminal.buffer.onBufferChange(() => this.captureViewport())
    this.releases.push(() => onBufferChange.dispose())
    // Output can advance baseY while a user is reading history. Restore the
    // tracked line after parsing; bottom followers use xterm's native follow
    // behavior and only get corrected if a resize left them above baseY.
    const onWriteParsed = this.terminal.onWriteParsed(() => {
      this.restoreViewport()
      this.scheduleScreenCheckpoint()
    })
    this.releases.push(() => onWriteParsed.dispose())
    // Detached tabs retain live terminals too; apply preferences without a React remount.
    this.releases.push(subscribeTerminalAppearance(() => this.applyAppearance()))
    // A retained session can have no mounted <Terminal> component while its
    // view is hidden in another tab. Subscribe at the session boundary so a
    // palette switch updates every live xterm, including those detached DOM
    // nodes, and repaints after WebKit moves the canvas.
    this.releases.push(subscribeTheme(() => {
      this.applyTheme()
      this.repaint()
      this.scheduleRepaint(this.attachment)
      this.requestNativeRedraw()
    }))
    this.ready = this.start(cwd, onSpawn)
  }

  private trackUserScrollIntent() {
    const extend = () => { this.userScrollUntil = performance.now() + 400 }
    const onKey = (event: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key) && (event.shiftKey || event.metaKey)) extend()
    }
    const onPointerDown = () => { this.pointerScrolling = true }
    const onPointerUp = () => {
      if (!this.pointerScrolling) return
      this.pointerScrolling = false
      extend()
    }
    const options = { capture: true, passive: true }
    this.element.addEventListener('wheel', extend, options)
    this.element.addEventListener('touchmove', extend, options)
    this.element.addEventListener('keydown', onKey, true)
    this.element.addEventListener('pointerdown', onPointerDown, options)
    window.addEventListener('pointerup', onPointerUp, true)
    this.releases.push(() => {
      this.element.removeEventListener('wheel', extend, options)
      this.element.removeEventListener('touchmove', extend, options)
      this.element.removeEventListener('keydown', onKey, true)
      this.element.removeEventListener('pointerdown', onPointerDown, options)
      window.removeEventListener('pointerup', onPointerUp, true)
    })
  }

  private userIsScrolling() {
    return this.pointerScrolling || performance.now() < this.userScrollUntil
  }

  private followLiveOutput() {
    if (this.viewport.followOutput) return
    this.disposeViewportMarker()
    this.viewport = { buffer: this.terminal.buffer.active.type, followOutput: true, marker: null, fallbackLine: 0 }
  }

  private disposeViewportMarker() {
    this.viewport.marker?.dispose()
    this.viewport.marker = null
  }

  private captureViewport() {
    const buffer = this.terminal.buffer.active
    const followOutput = buffer.type === 'alternate' || buffer.viewportY >= buffer.baseY
    if (buffer.type === 'alternate' || followOutput) {
      this.disposeViewportMarker()
      this.viewport = { buffer: buffer.type, followOutput, marker: null, fallbackLine: buffer.viewportY }
      return
    }

    if (this.viewport.buffer !== 'normal' || this.viewport.marker?.line !== buffer.viewportY) {
      this.disposeViewportMarker()
      const cursorLine = buffer.baseY + buffer.cursorY
      this.viewport.marker = this.terminal.registerMarker(buffer.viewportY - cursorLine)
    }
    this.viewport = {
      buffer: 'normal',
      followOutput: false,
      marker: this.viewport.marker,
      fallbackLine: buffer.viewportY,
    }
  }

  private restoreViewport() {
    const buffer = this.terminal.buffer.active
    if (buffer.type !== this.viewport.buffer) {
      this.captureViewport()
      return
    }
    this.restoringViewport = true
    try {
      if (buffer.type === 'normal' && this.viewport.followOutput) {
        if (buffer.viewportY < buffer.baseY) this.terminal.scrollToBottom()
      } else if (buffer.type === 'normal' && !this.viewport.followOutput) {
        const line = this.viewport.marker?.line ?? -1
        // A marker is disposed when bounded scrollback evicts its line. In
        // that case show the nearest surviving history instead of jumping to
        // live output or to an unrelated old numeric offset.
        this.terminal.scrollToLine(line >= 0 ? line : Math.min(this.viewport.fallbackLine, buffer.baseY))
      }
    } finally {
      this.restoringViewport = false
    }
  }

  private notify() { this.listeners.forEach(listener => listener()) }
  private scheduleScreenCheckpoint() {
    if (!this.onScreen || this.screenTimer !== null) return
    // Output can be byte-dense. One bounded checkpoint every two seconds keeps
    // persistence off the PTY hot path while still recovering useful context.
    this.screenTimer = setTimeout(() => {
      this.screenTimer = null
      this.checkpointScreen()
    }, 2000)
  }
  checkpointScreen() {
    if (!this.onScreen || this.closed) return
    const buffer = this.terminal.buffer.active
    const first = Math.max(0, buffer.length - 200)
    const lines: string[] = []
    let chars = 0
    for (let index = first; index < buffer.length && chars < 64 * 1024; index++) {
      const line = buffer.getLine(index)?.translateToString(true) ?? ''
      const bounded = line.slice(0, Math.max(0, 64 * 1024 - chars))
      lines.push(bounded)
      chars += bounded.length
    }
    this.onScreen(this.paneId, {
      lines,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      buffer: buffer.type,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      capturedAt: Date.now(),
    })
  }
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
        if (!this.closed) {
          const data = this.outputNormalizer.push(event.payload.data)
          if (data) this.terminal.write(data)
        }
      })
      if (this.closed) { output(); return }
      this.releases.push(output)
      const exit = await listen<{ id: number }>(`pty_exit:${eventKey}`, () => {
        if (this.closed) return
        const pending = this.outputNormalizer.finish()
        if (pending) this.terminal.write(pending)
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
    this.attachedHost = host
    this.element.removeAttribute('aria-hidden')
    host.appendChild(this.element)
    this.applyTheme()
    this.applyAppearance()
    this.resize(host)
    this.restoreViewport()
    this.repaint(attachment)
    this.scheduleRepaint(attachment)
  }
  detach(host: HTMLElement) {
    if (this.element.parentElement === host) {
      this.attachedHost = null
      // Do not let the xterm screen leave the document between React hosts.
      // Keeping it in a transparent, aria-hidden parking host avoids the
      // WebKit IntersectionObserver pause race while retaining the same
      // buffer, PTY, PID and input handlers.
      getParkingHost()?.appendChild(this.element)
    }
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
    // The immediate refresh covers browsers which paint synchronously. One
    // committed layout frame covers WKWebView reparenting. Geometry itself is
    // driven by ResizeObserver; do not poll fit across animation frames.
    this.repaintFrame = requestAnimationFrame(() => {
      if (this.closed || attachment !== this.attachment) return
      this.repaintFrame = null
      this.repaint(attachment)
    })
  }
  applyTheme() {
    const palette = getActivePalette()
    // Pass a fresh complete object. xterm compares option objects by identity;
    // cloning also prevents a renderer or an OSC color mutation from changing
    // the shared bundled palette used by the next session.
    this.terminal.options.theme = palette
      ? { ...palette }
      : { background: '#1f2335', foreground: '#c0caf5', cursor: '#c0caf5' }
    // Request a full screen refresh after replacing the theme. Keep the
    // retained buffer, PTY, PID and input handlers untouched; WebKit's canvas
    // renderer has its own atlas lifecycle and owns invalidation here.
    this.repaint()
  }
  /** Ask the running TUI to repaint without injecting a user keystroke. */
  private requestNativeRedraw() {
    if (this.closed || this.id === null || this.phase !== 'running') return
    void invoke('pty_resize', { id: this.id, cols: this.terminal.cols, rows: this.terminal.rows })
      .catch(error => this.fail(error))
  }
  applyAppearance() {
    const appearance = getTerminalAppearance()
    this.terminal.options.fontFamily = `${appearance.fontFamily}, monospace`
    this.terminal.options.fontSize = appearance.fontSize
    this.terminal.options.lineHeight = appearance.lineHeight
    this.terminal.options.cursorStyle = appearance.cursorStyle
    this.terminal.options.cursorBlink = appearance.cursorBlink
    this.terminal.options.scrollback = appearance.scrollback
    // Detached sessions sit in a deliberately tiny parking host. Updating
    // options there must not fit xterm or resize the native PTY to 2x1; the
    // active host's ResizeObserver will fit it when it is visible again.
    if (this.attachedHost) this.resize(this.attachedHost)
  }
  resize(host = this.attachedHost) {
    // Ignore queued observers from an old React host and every update while
    // parked. `isConnected` alone is insufficient because the parking host is
    // intentionally connected and has a 1x1 box.
    if (this.closed || !host || host !== this.attachedHost || this.element.parentElement !== host || !host.isConnected) return
    const bounds = host.getBoundingClientRect()
    if (bounds.width <= 1 || bounds.height <= 1) return
    try { this.fit.fit() } catch { return }
    this.restoreViewport()
    const size = `${this.terminal.cols}:${this.terminal.rows}`
    if (this.id !== null && this.phase === 'running' && this.nativeSize !== size) {
      this.nativeSize = size
      void invoke('pty_resize', { id: this.id, cols: this.terminal.cols, rows: this.terminal.rows }).catch(error => this.fail(error))
    }
  }
  focus() {
    if (!this.attachedHost || this.element.parentElement !== this.attachedHost) return false
    const active = document.activeElement
    if (active instanceof Element) {
      if (active.closest('dialog[open], [role="dialog"]')) return false
      if (!this.element.contains(active) && (active.matches('input, textarea, select') || (active as HTMLElement).isContentEditable)) return false
    }
    this.terminal.focus()
    return true
  }
  /** Insert dropped file paths as shell-quoted arguments, like macOS terminals. */
  pastePaths(paths: string[]) {
    if (this.closed || this.phase !== 'running' || paths.length === 0) return false
    this.terminal.paste(`${paths.map(shellQuote).join(' ')} `)
    this.focus()
    return true
  }
  async snapshot(): Promise<TerminalLifecycleSnapshot> {
    const host = this.attachedHost
    const rect = host?.getBoundingClientRect()
    const buffer = this.terminal.buffer.active
    let native: NativePtySnapshot | null = null
    if (this.id !== null) {
      try { native = await invoke<NativePtySnapshot>('pty_snapshot', { id: this.id }) } catch { /* exited between inspection and IPC */ }
    }
    const active = document.activeElement
    return {
      paneId: this.paneId,
      ptyId: this.id,
      pid: native?.pid ?? null,
      phase: this.phase,
      attached: host !== null,
      container: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      font: {
        family: String(this.terminal.options.fontFamily ?? ''),
        size: Number(this.terminal.options.fontSize ?? 0),
        lineHeight: Number(this.terminal.options.lineHeight ?? 1),
      },
      terminal: { cols: this.terminal.cols, rows: this.terminal.rows },
      native: native ? { cols: native.cols, rows: native.rows } : null,
      viewport: { buffer: buffer.type, line: buffer.viewportY, base: buffer.baseY, followOutput: this.viewport.followOutput },
      activeElement: active instanceof HTMLElement ? `${active.tagName.toLowerCase()}${active.className ? `.${String(active.className).split(/\s+/).join('.')}` : ''}` : null,
      ownsInputFocus: active instanceof Node && this.element.contains(active),
    }
  }
  dispose() {
    if (this.closed) return
    this.checkpointScreen()
    this.closed = true
    this.attachment++
    if (this.repaintFrame !== null) cancelAnimationFrame(this.repaintFrame)
    if (this.screenTimer !== null) clearTimeout(this.screenTimer)
    this.disposeViewportMarker()
    this.releases.splice(0).forEach(release => release())
    this.listeners.clear()
    this.terminal.dispose()
    this.element.remove()
    if (this.id !== null) void invoke('pty_kill', { id: this.id }).catch(() => {})
  }
}

const sessions = new Map<string, TerminalSession>()
export function getTerminalSession(
  paneId: string,
  cwd: string,
  onSpawn: (paneId: string, id: number) => void,
  onScreen?: (paneId: string, screen: PersistedTerminalScreen) => void,
): TerminalSession {
  let session = sessions.get(paneId)
  if (!session) { session = new TerminalSession(paneId, cwd, onSpawn, onScreen); sessions.set(paneId, session) }
  return session
}
/** The live session whose xterm screen contains `node`, if any. */
export function terminalSessionForNode(node: Node): TerminalSession | null {
  for (const session of sessions.values()) {
    if (session.element.contains(node)) return session
  }
  return null
}
/** POSIX-quote a path only when the shell would otherwise split or expand it. */
export function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}
export function flushTerminalSessionScreens() {
  for (const session of sessions.values()) session.checkpointScreen()
}
export function disposeTerminalSession(paneId: string) {
  sessions.get(paneId)?.dispose()
  sessions.delete(paneId)
}
export function inspectTerminalSession(paneId: string): Promise<TerminalLifecycleSnapshot | null> {
  return sessions.get(paneId)?.snapshot() ?? Promise.resolve(null)
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
