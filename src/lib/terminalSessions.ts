// UI-lifetime terminal sessions. React attaches/detaches their DOM; only an
// explicit pane/workspace close disposes xterm and its native process.
import { Terminal as XTerm, type IMarker } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { SearchAddon } from '@xterm/addon-search'
import type { FindOptions } from './find'
import { invoke } from '@tauri-apps/api/core'
import { safeListen as listen } from './listenerRegistry'
import { getActivePalette, subscribeTheme } from '../state/theme'
import { getTerminalAppearance, resolveCmdColor, subscribeTerminalAppearance } from '../state/terminalAppearance'
import { matchedCommand } from '../state/commands'
import { notifyPane } from '../state/paneNotifications'
import { activeTerminalPaneId, isLocalUrl, openUrlInBrowserTab, paneHostKey, setPaneAgentCli, setPaneAgentSession, showInBrowserPane, type AgentCli } from '../state/termPanes'
import { findFilePaths, isOpenableWebUrl } from './terminalLinks'
import { openInEditor } from './openInEditor'
import { macTerminalKeyAction } from './terminalKeys'
import { shellQuote } from './shellQuote'
import { fileUrlToPath } from './abbreviatePath'
import { shouldJournalPrompts, shouldKeepTerminalsRunning, subscribeSessionPreferences } from '../state/sessionPreferences'
import { isAgentSessionId } from '../state/agentHooks'
import { PromptInputAccumulator, journalPrompt } from './promptJournal'
import { applyStatuslineUsage, clearPaneUsage, notePaneAgent, parseUsageReport, refreshPaneUsage, type UsageProvider } from '../state/paneUsage'

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
  viewport: { buffer: 'normal' | 'alternate'; line: number; base: number; followOutput: boolean; mouseTracking: string }
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

// Bundled Nerd Font: WKWebView does not expose user-installed fonts, so icon
// glyphs (LazyVim, starship, eza) need a font shipped with the app. It sits
// after the chosen family and only supplies glyphs that family lacks.
export const NERD_FONT_FALLBACK = "'JetBrainsMono Nerd Font'"
export function terminalFontStack(family: string): string {
  return `${family}, ${NERD_FONT_FALLBACK}, monospace`
}

// A drag or window resize reports many intermediate sizes. Each native resize
// is a SIGWINCH, and Claude Code and Codex reprint their transcript on every
// one, which leaves repeated text in scrollback. Send only the settled size.
const NATIVE_RESIZE_SETTLE_MS = 90

// "Quiet after work": output that ran for at least BUSY_MIN_MS with no gap
// longer than BUSY_GAP_MS, followed by QUIET_MS of silence.
const BUSY_GAP_MS = 1500
const BUSY_MIN_MS = 4000
const QUIET_MS = 3000
// Flow control: acknowledge parsed output in batches, and promptly when it stops.
const ACK_BATCH_BYTES = 256 * 1024
const ACK_IDLE_MS = 50
// Saved screens rewrite the whole workspace store, so keep them occasional.
const SCREEN_CHECKPOINT_MS = 5000
// Output this soon after a keystroke is echo, not work.
const ECHO_WINDOW_MS = 300
// How often a visible pane checks which agent CLI (and session) it is running.
const FOREGROUND_POLL_MS = 3000

// A downward gesture that lands this close to the live bottom means "back to
// live output". Rounding of fractional row heights can leave the last wheel
// step one row short of baseY, and a wheel at the end emits no scroll event.
const FOLLOW_SLACK_ROWS = 1

/**
 * True when `data` (from xterm's onData) is only the terminal answering the
 * program: focus reports (mode 1004), device attributes, mode and status
 * reports, window reports, OSC and DCS replies. These are not the user
 * typing and must not pull a history reader back to live output. Mouse
 * reports are user gestures and CPR (`ESC[r;cR`) is byte-identical to a
 * modified F3, so neither is listed.
 */
export function isTerminalReport(data: string): boolean {
  if (!data.startsWith(ESC)) return false
  return /^(?:\x1b\[[IO]|\x1b\[[?>][\d;]*c|\x1b\[\d*n|\x1b\[\??[\d;]+\$y|\x1b\[\d+(?:;\d+)*t|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/.test(data)
}

/**
 * Where a history reader should be shown when its anchor marker is gone.
 * A marker dies when its line leaves the buffer: either bounded scrollback
 * evicted it (the caller then passes fallbackLine 0, the nearest surviving
 * history), or the program cleared scrollback with ESC[3J. Ink-based CLIs
 * (Gemini) clear and reprint their whole transcript, so after a clear the
 * same absolute line holds the same content again once it is reprinted;
 * until then the reader waits at the newest line that exists.
 */
export function anchorAfterMarkerLoss(fallbackLine: number, baseY: number): { line: number; reanchor: boolean } {
  return { line: Math.max(0, Math.min(fallbackLine, baseY)), reanchor: fallbackLine <= baseY }
}

/** Text of an OSC 9 / 99 / 777 desktop-notification sequence, or null if it is not one. */
export function oscNotificationText(ident: 9 | 99 | 777, data: string): string | null {
  if (ident === 9) {
    // OSC 9;4 and other numeric subcommands are progress reports, not messages.
    return /^\d+(;|$)/.test(data) ? null : data
  }
  if (ident === 777) {
    const [kind, title = '', ...body] = data.split(';')
    if (kind !== 'notify') return null
    return [title, body.join(';')].filter(Boolean).join(': ')
  }
  const separator = data.indexOf(';')
  if (separator === -1) return null
  const metadata = data.slice(0, separator).split(':')
  // Kitty sends close/query/icon payloads on the same code; only text counts.
  const payloadType = metadata.find(item => item.startsWith('p='))?.slice(2) ?? 'title'
  if (payloadType !== 'title' && payloadType !== 'body') return null
  return data.slice(separator + 1)
}

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

export interface FindColors { match: string; matchBorder: string; active: string; activeBorder: string }

export class TerminalSession {
  readonly element = document.createElement('div')
  readonly terminal = new XTerm({ fontFamily: terminalFontStack("'JetBrains Mono'"), fontSize: 13, cursorBlink: true, scrollback: 3000, allowProposedApi: true, altClickMovesCursor: true, macOptionClickForcesSelection: true })
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
  // Output (new lines, ESC[3J) moves baseY; a user's scroll never does. A
  // scroll event that arrives with a different baseY came from output, even
  // inside the gesture window, and must not be read as the user's position.
  private lastBaseY = 0
  private lastViewportY = 0
  // Set by a CSI 3 J (clear scrollback) for the rest of that write, so a marker
  // it disposes is told apart from one evicted by the scrollback limit.
  private clearingScrollback = false
  private wheelRemainder = 0
  private screenTimer: ReturnType<typeof setTimeout> | null = null
  private nativeResizeTimer: ReturnType<typeof setTimeout> | null = null
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private busySince = 0
  private lastOutputAt = 0
  private lastInputAt = 0
  private startupCommand: string | null = null
  private startupSubmit = true
  private sawOutput = false
  // The agent CLI in the foreground; Gemini is tracked for usage only (no resume).
  private agentCli: UsageProvider | null = null
  // What was typed since the last Enter, for the prompt journal (agent panes only).
  private readonly promptInput = new PromptInputAccumulator()
  private codexSessionKnown = false
  private foregroundTimer: ReturnType<typeof setInterval> | null = null
  private foregroundPolls = 0
  private foregroundInFlight = false
  // Polls in a row that found no agent; one miss is not enough to drop live usage.
  private agentMisses = 0
  private lastUsageReportAt = -Infinity
  // A program that sends its own notifications does not need the quiet-after-work guess.
  private selfReporting = false
  private replaying = false
  private unacknowledged = 0
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private lastCheckpoint = ''

  constructor(
    readonly paneId: string,
    cwd: string,
    onSpawn: (paneId: string, id: number) => void,
    private readonly onScreen?: (paneId: string, screen: PersistedTerminalScreen) => void,
  ) {
    this.element.style.cssText = 'width:100%;height:100%;'
    this.terminal.loadAddon(this.fit)
    this.terminal.loadAddon(new WebLinksAddon((event, uri) => openTerminalLink(uri, event)))
    // Command+click on a file path (optionally path:line:col) opens it in the
    // editor: an nvim already open in this tab, or a new split running it.
    this.terminal.registerLinkProvider({
      provideLinks: (row, callback) => {
        const line = this.terminal.buffer.active.getLine(row - 1)?.translateToString(true) ?? ''
        const links = findFilePaths(line).map(match => ({
          text: match.text,
          range: { start: { x: match.start + 1, y: row }, end: { x: match.end, y: row } },
          activate: (event: MouseEvent) => {
            if (!event.metaKey) return
            void openInEditor(match, { ptyId: this.id, cwd })
          },
        }))
        callback(links.length ? links : undefined)
      },
    })
    this.terminal.open(this.element)
    this.terminal.attachCustomKeyEventHandler(e => this.handleKey(e))
    this.registerNotificationSources()
    this.applyTheme()
    this.applyAppearance()
    const onData = this.terminal.onData(data => {
      if (this.phase !== 'running' || this.closed) return
      // xterm's scrollOnUserInput snaps typing back to the live prompt before
      // onData fires, and only for user input; adopt that as the new intent so
      // the next write does not scroll away again. Replies xterm sends on the
      // program's behalf (a focus report on every focus change, DA, DECRQM)
      // arrive here too but are not typing: they leave the reader in place.
      if (this.terminal.options.scrollOnUserInput !== false && !isTerminalReport(data)) {
        const buffer = this.terminal.buffer.active
        if (buffer.type === 'alternate' || buffer.viewportY >= buffer.baseY) this.followLiveOutput()
      }
      this.journalInput(data, cwd)
      this.send(data)
    })
    this.releases.push(() => onData.dispose())
    // xterm 5.3 fires onScroll only for scrolls it starts itself (output,
    // scrollLines/scrollToBottom, ESC[3J). A wheel or scrollbar drag moves the
    // DOM viewport, whose scroll listener updates ydisp with the API event
    // suppressed, so the user's own scroll is read from that DOM event. Ours is
    // added after xterm's, so ydisp is already current when it runs.
    const onScroll = this.terminal.onScroll(() => this.handleScroll())
    this.releases.push(() => onScroll.dispose())
    const viewportElement = this.element.querySelector('.xterm-viewport')
    if (viewportElement) {
      const onDomScroll = () => this.handleScroll()
      viewportElement.addEventListener('scroll', onDomScroll, { passive: true })
      this.releases.push(() => viewportElement.removeEventListener('scroll', onDomScroll))
    }
    const onEraseDisplay = this.terminal.parser.registerCsiHandler({ final: 'J' }, params => {
      this.clearingScrollback = params[0] === 3
      return false // xterm's own handler still erases
    })
    this.releases.push(() => onEraseDisplay.dispose())
    this.trackUserScrollIntent()
    const onBufferChange = this.terminal.buffer.onBufferChange(() => this.captureViewport())
    this.releases.push(() => onBufferChange.dispose())
    // Output can advance baseY while a user is reading history. Restore the
    // tracked line after parsing; bottom followers use xterm's native follow
    // behavior and only get corrected if a resize left them above baseY.
    const onWriteParsed = this.terminal.onWriteParsed(() => {
      this.restoreViewport()
      this.clearingScrollback = false
      this.lastBaseY = this.terminal.buffer.active.baseY
      this.lastViewportY = this.terminal.buffer.active.viewportY
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

  /** Tell the reader how much xterm has parsed. Batched: this is the hot path. */
  private acknowledge(bytes: number, id: number) {
    this.unacknowledged += bytes
    if (this.unacknowledged < ACK_BATCH_BYTES && this.ackTimer === null) {
      this.ackTimer = setTimeout(() => this.flushAcknowledgement(id), ACK_IDLE_MS)
      return
    }
    if (this.unacknowledged >= ACK_BATCH_BYTES) this.flushAcknowledgement(id)
  }
  private flushAcknowledgement(id: number) {
    if (this.ackTimer !== null) { clearTimeout(this.ackTimer); this.ackTimer = null }
    const bytes = this.unacknowledged
    this.unacknowledged = 0
    if (bytes > 0 && !this.closed) void invoke('pty_ack', { id, bytes }).catch(() => {})
  }

  /** Keep what the user submits to an agent. A plain shell is never journaled. */
  private journalInput(data: string, cwd: string) {
    if (!this.agentCli || !shouldJournalPrompts()) { this.promptInput.reset(); return }
    if (isTerminalReport(data)) return
    const text = this.promptInput.feed(data)
    if (!text) return
    const provider = this.agentCli
    // The workspace folder names the journal; loaded on demand so this module stays free of the workspace store.
    void import('./paneWorkspace')
      .then(module => module.paneWorkspace(this.paneId)?.path ?? cwd)
      .catch(() => cwd)
      .then(workspace => journalPrompt(workspace, provider, text))
  }

  private send(data: string) {
    this.lastInputAt = performance.now()
    this.input = this.input.then(() => {
      if (!this.closed && this.id !== null) return invoke('pty_write', { id: this.id, data })
    }).catch(error => this.fail(error))
  }

  /** xterm custom key hook: false means "handled here, do not send". */
  private handleKey(event: KeyboardEvent): boolean {
    if (matchedCommand(event)) return false
    // Cmd+C normally arrives as the Edit menu's copy event. Writing the
    // selection here as well covers a WebView that has lost that menu route.
    if (event.type === 'keydown' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c' && this.terminal.hasSelection()) {
      copyText(this.terminal.getSelection())
      return false
    }
    if (!getTerminalAppearance().macEditingKeys) return true
    const action = macTerminalKeyAction(event, this.terminal.buffer.active.type)
    if (!action) return true
    // xterm also routes keypress/keyup through this hook; act once, on keydown.
    if (event.type === 'keydown') {
      event.preventDefault()
      if (action.kind === 'scroll') {
        this.userScrollUntil = performance.now() + 400
        if (action.to === 'top') this.terminal.scrollToTop()
        else this.terminal.scrollToBottom()
      } else if (this.phase === 'running' && !this.closed) {
        this.followLiveOutput()
        this.send(action.data)
      }
    }
    return false
  }

  private registerNotificationSources() {
    const bell = this.terminal.onBell(() => { if (!this.replaying) notifyPane(this.paneId, 'bell') })
    this.releases.push(() => bell.dispose())
    for (const ident of [9, 99, 777] as const) {
      const handler = this.terminal.parser.registerOscHandler(ident, data => {
        const text = oscNotificationText(ident, data)
        if (text === null) return false
        if (this.replaying) return true
        this.selfReporting = true
        notifyPane(this.paneId, 'osc', text)
        return true
      })
      this.releases.push(() => handler.dispose())
    }
    // Private to Beads Station: a Claude Code hook reporting its session id,
    // and the status line wrapper reporting context and limit use.
    const session = this.terminal.parser.registerOscHandler(7770, data => {
      const [kind, cli, id] = data.split(';')
      if (kind === 'session' && cli === 'claude' && isAgentSessionId(id)) {
        setPaneAgentSession(this.paneId, 'claude', id)
        notePaneAgent(this.paneId, 'claude', id)
        refreshPaneUsage(this.paneId, null, true)
      } else if (kind === 'usage') {
        // A replayed report is from before the restart; the next live one follows soon.
        if (this.replaying) return true
        const report = parseUsageReport(data)
        if (!report) return true
        this.lastUsageReportAt = performance.now()
        this.agentCli = 'claude'
        this.agentMisses = 0
        applyStatuslineUsage(this.paneId, report)
        if (report.sessionId) setPaneAgentSession(this.paneId, 'claude', report.sessionId)
        refreshPaneUsage(this.paneId)
      }
      return true
    })
    this.releases.push(() => session.dispose())
  }

  /** Track sustained output so a background pane can report when it goes quiet. */
  private noteOutput() {
    const now = performance.now()
    if (now - this.lastInputAt < ECHO_WINDOW_MS) return
    if (now - this.lastOutputAt > BUSY_GAP_MS) this.busySince = now
    this.lastOutputAt = now
    if (this.quietTimer === null) this.quietTimer = setTimeout(() => this.checkQuiet(), QUIET_MS)
  }

  private checkQuiet() {
    this.quietTimer = null
    if (this.closed) return
    const silence = performance.now() - this.lastOutputAt
    if (silence < QUIET_MS) {
      this.quietTimer = setTimeout(() => this.checkQuiet(), QUIET_MS - silence)
      return
    }
    const worked = this.lastOutputAt - this.busySince
    this.busySince = 0
    if (worked >= BUSY_MIN_MS && this.phase === 'running' && !this.selfReporting) notifyPane(this.paneId, 'quiet')
  }

  private trackUserScrollIntent() {
    const extend = () => { this.userScrollUntil = performance.now() + 400 }
    const onWheel = (event: WheelEvent) => {
      extend()
      const buffer = this.terminal.buffer.active
      if (buffer.type !== 'normal') return
      if (this.wheelScrollsHistory(event)) return
      // At (or a rounding row above) the end a wheel down produces no scroll
      // event, so it is read here: the user asked for live output.
      if (event.deltaY > 0 && !this.viewport.followOutput && buffer.viewportY >= buffer.baseY - FOLLOW_SLACK_ROWS) this.returnToLiveOutput()
    }
    const onKey = (event: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key) && (event.shiftKey || event.metaKey)) extend()
    }
    const onPointerDown = () => { this.pointerScrolling = true }
    const onPointerUp = () => {
      if (!this.pointerScrolling) return
      this.pointerScrolling = false
      extend()
      // The release of a drag that began in this terminal, wherever it ends.
      // It is a user gesture, which the clipboard requires.
      if (getTerminalAppearance().copyOnSelect && this.terminal.hasSelection()) copyText(this.terminal.getSelection())
    }
    const options = { capture: true, passive: true }
    // Not passive: with mouse tracking on, the wheel is taken from xterm.
    this.element.addEventListener('wheel', onWheel, { capture: true, passive: false })
    this.element.addEventListener('touchmove', extend, options)
    this.element.addEventListener('keydown', onKey, true)
    this.element.addEventListener('pointerdown', onPointerDown, options)
    window.addEventListener('pointerup', onPointerUp, true)
    this.releases.push(() => {
      this.element.removeEventListener('wheel', onWheel, { capture: true })
      this.element.removeEventListener('touchmove', extend, options)
      this.element.removeEventListener('keydown', onKey, true)
      this.element.removeEventListener('pointerdown', onPointerDown, options)
      window.removeEventListener('pointerup', onPointerUp, true)
    })
  }

  /**
   * A program that turns on mouse tracking gets the wheel as mouse reports
   * (and xterm snaps to the bottom for each), so the scrollback above it
   * cannot be read with the wheel. Plain wheel stays the program's: programs
   * such as `fzf --height` run in the normal buffer with the mouse on and
   * scroll their own list. Shift+wheel, which xterm 5.3 ignores (no report,
   * no scroll), scrolls the normal buffer's history instead. The alternate
   * screen has no scrollback and is left alone.
   */
  private wheelScrollsHistory(event: WheelEvent): boolean {
    const mode = this.terminal.modes?.mouseTrackingMode ?? 'none'
    const buffer = this.terminal.buffer.active
    if (!event.shiftKey || mode === 'none' || buffer.type !== 'normal' || buffer.baseY === 0) return false
    event.preventDefault()
    event.stopPropagation()
    // macOS turns Shift+wheel into a horizontal delta.
    const delta = event.deltaY || (event.shiftKey ? event.deltaX : 0)
    if (!delta) return true
    let lines: number
    if (event.deltaMode === 1) lines = delta
    else if (event.deltaMode === 2) lines = delta * this.terminal.rows
    else {
      const screen = this.element.querySelector('.xterm-screen')
      const rowHeight = (screen?.getBoundingClientRect().height ?? 0) / Math.max(1, this.terminal.rows) || 16
      lines = delta / rowHeight
    }
    this.wheelRemainder += lines
    const whole = Math.trunc(this.wheelRemainder)
    this.wheelRemainder -= whole
    if (whole === 0) return true
    if (whole > 0 && buffer.viewportY + whole >= buffer.baseY - FOLLOW_SLACK_ROWS) {
      this.returnToLiveOutput()
      return true
    }
    this.terminal.scrollLines(whole)
    return true
  }

  /** The user scrolled back to the end: follow live output from here. */
  private returnToLiveOutput() {
    this.followLiveOutput()
    this.restoringViewport = true
    try { this.terminal.scrollToBottom() } finally { this.restoringViewport = false }
    this.lastBaseY = this.terminal.buffer.active.baseY
    this.lastViewportY = this.terminal.buffer.active.viewportY
  }

  private handleScroll() {
    const buffer = this.terminal.buffer.active
    const outputMoved = buffer.baseY !== this.lastBaseY
    const movedDown = buffer.viewportY > this.lastViewportY
    this.lastBaseY = buffer.baseY
    this.lastViewportY = buffer.viewportY
    if (this.restoringViewport || outputMoved || !this.userIsScrolling()) return
    if (buffer.type === 'normal' && movedDown && buffer.viewportY >= buffer.baseY - FOLLOW_SLACK_ROWS) {
      this.returnToLiveOutput()
      return
    }
    this.captureViewport()
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
    const marker = this.viewport.marker
    this.viewport.marker = null
    marker?.dispose()
  }

  /** Anchor the reader at an absolute buffer line with a marker that follows trimming. */
  private anchorAt(line: number): IMarker | null {
    const buffer = this.terminal.buffer.active
    const marker = this.terminal.registerMarker(line - (buffer.baseY + buffer.cursorY))
    if (!marker) return null
    marker.onDispose(() => {
      if (this.viewport.marker !== marker) return
      this.viewport.marker = null
      // Evicted by the scrollback limit: what survives starts at line 0.
      // Cleared by the program: keep the absolute line for its reprint.
      if (!this.clearingScrollback) this.viewport.fallbackLine = 0
    })
    return marker
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
      this.viewport.marker = this.anchorAt(buffer.viewportY)
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
        const marker = this.viewport.marker
        const line = marker && !marker.isDisposed ? marker.line : -1
        if (line >= 0) {
          this.viewport.fallbackLine = line
          this.terminal.scrollToLine(line)
        } else {
          // The marker's line left the buffer (see anchorAfterMarkerLoss).
          // Never jump to live output: the user is still reading.
          const next = anchorAfterMarkerLoss(this.viewport.fallbackLine, buffer.baseY)
          this.terminal.scrollToLine(next.line)
          if (next.reanchor) this.viewport.marker = this.anchorAt(next.line)
        }
      }
    } finally {
      this.restoringViewport = false
    }
  }

  private notify() { this.listeners.forEach(listener => listener()) }
  private scheduleScreenCheckpoint() {
    if (!this.onScreen || this.screenTimer !== null) return
    // Output can be byte-dense. One bounded checkpoint every few seconds keeps
    // persistence off the PTY hot path while still recovering useful context.
    this.screenTimer = setTimeout(() => {
      this.screenTimer = null
      this.checkpointScreen()
    }, SCREEN_CHECKPOINT_MS)
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
    // A redraw of the same screen is not worth another store write.
    const fingerprint = lines.join('\n')
    if (fingerprint !== this.lastCheckpoint) {
      this.lastCheckpoint = fingerprint
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
    this.observeForeground()
  }
  /**
   * Which agent CLI (and which session) owns this shell: for an explicit
   * resume after a restart, and for the pane's live usage. Reads process
   * information and small files only; starts nothing.
   */
  private observeForeground() {
    if (this.id === null || this.phase !== 'running' || this.foregroundInFlight) return
    this.foregroundPolls++
    // Claude's session is one small file read and can change (/clear, /resume),
    // so it is asked every time. Codex's costs an lsof: every poll until known,
    // then every third poll, so a /new inside Codex is still picked up.
    const wantSession = this.agentCli === 'claude' || this.agentCli === 'gemini'
      || (this.agentCli === 'codex' && (!this.codexSessionKnown || this.foregroundPolls % 3 === 0))
    this.foregroundInFlight = true
    void invoke<{ cli: string | null; sessionId: string | null; cwd?: string | null } | null>('pty_foreground', { id: this.id, wantSession })
      .then(foreground => {
        if (this.closed) return
        const found = foreground?.cli
        let cli: UsageProvider | null = found === 'claude' || found === 'codex' || found === 'gemini' ? found : null
        if (cli) this.agentMisses = 0
        else if (this.agentCli) {
          // A status line report proves Claude is there even if one process listing missed it.
          const recentReport = performance.now() - this.lastUsageReportAt < 15_000
          if (recentReport || ++this.agentMisses < 2) cli = this.agentCli
        }
        if (cli !== this.agentCli) {
          this.agentCli = cli
          this.codexSessionKnown = false
          // A different program now owns the pane; what the last one reported no longer applies.
          this.selfReporting = false
          // Ask for the session right away rather than on the next poll.
          if (cli) setTimeout(() => this.observeForeground(), 0)
        }
        // Gemini has no resume here; it is followed for usage only.
        const resumable: AgentCli | null = cli === 'claude' || cli === 'codex' ? cli : null
        setPaneAgentCli(this.paneId, resumable)
        const sessionId = cli && isAgentSessionId(foreground?.sessionId) ? foreground.sessionId : null
        if (resumable && sessionId) {
          if (resumable === 'codex') this.codexSessionKnown = true
          setPaneAgentSession(this.paneId, resumable, sessionId)
        }
        notePaneAgent(this.paneId, cli, sessionId)
        if (cli) refreshPaneUsage(this.paneId, foreground?.cwd ?? null)
      })
      .catch(() => { /* exited, or a backend without foreground inspection */ })
      .finally(() => { this.foregroundInFlight = false })
  }
  /** Poll the foreground every few seconds while this pane is on screen. */
  private startForegroundPolling() {
    if (this.foregroundTimer !== null) return
    this.foregroundTimer = setInterval(() => {
      if (this.closed || this.phase !== 'running') return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      // Parked or detached views are not on screen; checkpoints still observe them now and then.
      if (!this.attachedHost || !this.attachedHost.isConnected || this.element.parentElement !== this.attachedHost) return
      this.observeForeground()
    }, FOREGROUND_POLL_MS)
  }
  /** Run one command in the new shell after it has printed its first output. */
  runWhenReady(command: string, submit = true) {
    this.startupCommand = command
    this.startupSubmit = submit
    if (this.sawOutput) this.flushStartupCommand()
  }
  private flushStartupCommand() {
    const command = this.startupCommand
    if (command === null) return
    this.startupCommand = null
    const submit = this.startupSubmit
    // Let the login shell finish drawing its prompt before typing into it.
    setTimeout(() => {
      if (!this.closed && this.phase === 'running') this.send(submit ? `${command}\r` : command)
    }, 400)
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
      const output = await listen<{ id: number; data: string; replay?: boolean; ack?: number }>(`pty_data:${eventKey}`, event => {
        if (!this.closed) {
          const data = this.outputNormalizer.push(event.payload.data)
          if (event.payload.replay) {
            // History of a shell that kept running while the app was closed.
            // Its bells and notifications already happened; and nothing may be
            // typed into a program that is already running there.
            this.startupCommand = null
            this.replaying = true
            this.terminal.write(data, () => { this.replaying = false })
            this.sawOutput = true
            return
          }
          const ack = event.payload.ack ?? 0
          if (!ack) { if (data) this.terminal.write(data) }
          else if (data) this.terminal.write(data, () => this.acknowledge(ack, event.payload.id))
          else this.acknowledge(ack, event.payload.id)
          this.sawOutput = true
          this.noteOutput()
          this.flushStartupCommand()
        }
      })
      if (this.closed) { output(); return }
      this.releases.push(output)
      const exit = await listen<{ id: number }>(`pty_exit:${eventKey}`, () => {
        if (this.closed) return
        const pending = this.outputNormalizer.finish()
        if (pending) this.terminal.write(pending)
        this.phase = 'exited'
        if (this.foregroundTimer !== null) { clearInterval(this.foregroundTimer); this.foregroundTimer = null }
        clearPaneUsage(this.paneId)
        this.terminal.write('\r\n[process exited]\r\n')
        this.notify()
      })
      if (this.closed) { exit(); return }
      this.releases.push(exit)
      this.nativeSize = `${this.terminal.cols}:${this.terminal.rows}`
      const id = await invoke<number>('pty_spawn', { cwd, eventKey, cols: this.terminal.cols, rows: this.terminal.rows, persistKey: paneHostKey(this.paneId), cmdColor: resolveCmdColor() })
      if (this.closed) { await invoke('pty_kill', { id }); return }
      this.id = id
      // A fast-exiting shell can emit exit before spawn's response arrives.
      if (this.phase === 'starting') this.phase = 'running'
      onSpawn(this.paneId, id)
      this.startForegroundPolling()
      this.resize()
      // Layout may have changed while spawn was pending; apply it now rather
      // than after the settle delay, so the first prompt wraps correctly.
      this.syncNativeSize()
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
      this.repaint(attachment)
      this.resyncViewport()
      // xterm measures its cell size when its screen first intersects the
      // viewport, which the browser reports after this frame's callbacks.
      // Until then a fit is a no-op, and a host that never changes size would
      // keep the default 80x24. Fit once more, one frame later.
      this.repaintFrame = requestAnimationFrame(() => {
        if (this.closed || attachment !== this.attachment) return
        this.repaintFrame = null
        this.resize()
        this.resyncViewport()
      })
    })
  }
  /**
   * Moving the screen between React hosts (and through the 1px parking host)
   * resets or clamps the DOM scrollTop of `.xterm-viewport`. xterm 5.3 only
   * rewrites scrollTop when its own position changes, so a quiet shell keeps
   * a stale scrollbar and the next wheel jumps from it (toward the top), or a
   * clamp's scroll event moves the view. Restore the tracked position, then
   * step one line away and back so xterm itself rewrites scrollTop. Nothing
   * here is a user gesture.
   */
  private resyncViewport() {
    if (this.closed || !this.attachedHost) return
    this.restoreViewport()
    const buffer = this.terminal.buffer.active
    if (buffer.type !== 'normal' || buffer.baseY === 0) return
    const line = buffer.viewportY
    this.restoringViewport = true
    try {
      this.terminal.scrollLines(line > 0 ? -1 : 1)
      this.terminal.scrollToLine(line)
    } finally {
      this.restoringViewport = false
    }
    this.lastBaseY = buffer.baseY
    this.lastViewportY = buffer.viewportY
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
    this.terminal.options.fontFamily = terminalFontStack(/^[\w-]+$/.test(appearance.fontFamily) ? appearance.fontFamily : `'${appearance.fontFamily}'`)
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
    this.scheduleNativeResize()
  }
  private scheduleNativeResize() {
    if (this.nativeResizeTimer !== null) clearTimeout(this.nativeResizeTimer)
    this.nativeResizeTimer = setTimeout(() => {
      this.nativeResizeTimer = null
      this.syncNativeSize()
    }, NATIVE_RESIZE_SETTLE_MS)
  }
  private syncNativeSize() {
    const size = `${this.terminal.cols}:${this.terminal.rows}`
    if (this.closed || this.id === null || this.phase !== 'running' || this.nativeSize === size) return
    this.nativeSize = size
    void invoke('pty_resize', { id: this.id, cols: this.terminal.cols, rows: this.terminal.rows }).catch(error => this.fail(error))
  }
  // ---------- Find (Cmd+F) ----------
  private searchAddon: SearchAddon | null = null
  private searchLoading: Promise<SearchAddon> | null = null
  private findListeners = new Set<(result: { index: number; count: number }) => void>()

  /** Loaded on the first search only; most panes never need it. */
  private loadSearch(): Promise<SearchAddon> {
    if (this.searchAddon) return Promise.resolve(this.searchAddon)
    this.searchLoading ??= import('@xterm/addon-search').then(module => {
      const addon = new module.SearchAddon({ highlightLimit: 1000 })
      this.terminal.loadAddon(addon)
      addon.onDidChangeResults(result => this.findListeners.forEach(listener => listener({ index: result.resultIndex, count: result.resultCount })))
      this.searchAddon = addon
      return addon
    })
    return this.searchLoading
  }
  onFindResults(listener: (result: { index: number; count: number }) => void) {
    this.findListeners.add(listener)
    return () => { this.findListeners.delete(listener) }
  }
  /**
   * Select the next or previous match and highlight all of them. Moving to a
   * match is the user's own scroll: it must not be read as output, and the
   * reader's new position becomes the position to keep.
   */
  async find(query: string, options: FindOptions, direction: 'next' | 'previous', colors: FindColors, incremental = false): Promise<boolean> {
    if (this.closed) return false
    const addon = await this.loadSearch()
    this.userScrollUntil = performance.now() + 400
    const decorations = {
      matchBackground: colors.match, matchBorder: colors.matchBorder, matchOverviewRuler: colors.match,
      activeMatchBackground: colors.active, activeMatchBorder: colors.activeBorder, activeMatchColorOverviewRuler: colors.active,
    }
    const found = direction === 'next'
      ? addon.findNext(query, { regex: options.regex, caseSensitive: options.caseSensitive, incremental, decorations })
      : addon.findPrevious(query, { regex: options.regex, caseSensitive: options.caseSensitive, decorations })
    this.captureViewport()
    return found
  }
  clearFind() {
    this.searchAddon?.clearDecorations()
    this.terminal.clearSelection()
  }
  /** Every line of the active buffer, scrollback included, as plain text. */
  bufferLines(): string[] {
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    return lines
  }
  /** Scroll to a buffer line and select the match there. */
  reveal(line: number, col: number, length: number) {
    this.userScrollUntil = performance.now() + 400
    const buffer = this.terminal.buffer.active
    if (line < buffer.viewportY || line >= buffer.viewportY + this.terminal.rows) {
      this.terminal.scrollToLine(Math.max(0, line - Math.floor(this.terminal.rows / 2)))
    }
    this.terminal.select(col, line, length)
    this.captureViewport()
  }
  focus() {
    if (!this.attachedHost || this.element.parentElement !== this.attachedHost) return false
    const active = document.activeElement
    if (active instanceof Element) {
      if (active.closest('dialog[open], [role="dialog"]')) return false
      // Another pane's xterm input is a textarea too, and must not block the move.
      const typing = active.matches('input, textarea, select') || (active as HTMLElement).isContentEditable
      if (!this.element.contains(active) && typing && !active.classList.contains('xterm-helper-textarea')) return false
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
      viewport: { buffer: buffer.type, line: buffer.viewportY, base: buffer.baseY, followOutput: this.viewport.followOutput, mouseTracking: this.terminal.modes?.mouseTrackingMode ?? 'none' },
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
    if (this.ackTimer !== null) clearTimeout(this.ackTimer)
    if (this.nativeResizeTimer !== null) clearTimeout(this.nativeResizeTimer)
    if (this.quietTimer !== null) clearTimeout(this.quietTimer)
    if (this.foregroundTimer !== null) clearInterval(this.foregroundTimer)
    clearPaneUsage(this.paneId)
    this.disposeViewportMarker()
    this.releases.splice(0).forEach(release => release())
    this.listeners.clear()
    this.terminal.dispose()
    this.element.remove()
    if (this.id !== null) void invoke('pty_kill', { id: this.id }).catch(() => {})
  }
}

/**
 * A link clicked in terminal output. An address on this machine (the dev
 * server a command just printed) opens in a browser pane beside the terminal;
 * everything else opens as it always has.
 */
export function openTerminalLink(uri: string, event?: Pick<MouseEvent, 'metaKey'>) {
  // Command+click opens a new browser tab, leaving the pane being typed in alone;
  // a plain click shows local pages beside the terminal as before.
  if (!isOpenableWebUrl(uri)) return
  if (event?.metaKey && openUrlInBrowserTab(uri)) return
  if (!event?.metaKey && isLocalUrl(uri) && showInBrowserPane(uri)) return
  const opened = window.open()
  if (!opened) return
  try { opened.opener = null } catch { /* cross-origin window */ }
  opened.location.href = uri
}

/** Put text on the system clipboard; falls back to the focused element's copy event. */
export function copyText(text: string) {
  if (!text) return
  const fallback = () => { try { document.execCommand('copy') } catch { /* no clipboard in this context */ } }
  if (!navigator.clipboard?.writeText) { fallback(); return }
  navigator.clipboard.writeText(text).catch(fallback)
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
export { shellQuote }
export function flushTerminalSessionScreens() {
  for (const session of sessions.values()) session.checkpointScreen()
}
export function disposeTerminalSession(paneId: string) {
  sessions.get(paneId)?.dispose()
  sessions.delete(paneId)
}
/** Queue a command for a pane's freshly spawned shell (explicit user action only). */
export function runInTerminalSession(paneId: string, command: string, submit = true) {
  sessions.get(paneId)?.runWhenReady(command, submit)
}
/** The live session of a pane, if it has been created. Never creates one. */
export function findTerminalSession(paneId: string): TerminalSession | undefined {
  return sessions.get(paneId)
}
export function hasTerminalSession(paneId: string) {
  return sessions.has(paneId)
}
/** Paste text at a running session's cursor, without submitting it. */
export function pasteIntoTerminalSession(paneId: string, text: string) {
  const session = sessions.get(paneId)
  if (!session || session.phase !== 'running') return false
  session.terminal.paste(text)
  session.focus()
  return true
}
/** True when a paste already has somewhere to go: a field, or a terminal's own input. */
export function pasteHasOwnTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  return Boolean(element?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm, dialog[open], [role="dialog"]'))
}

// Command+V arrives as the Edit menu's paste, which WebKit delivers to the
// focused element. A terminal pane that is active but whose hidden input lost
// focus (after a click on a pane header, a tab, or coming back from another
// app) would drop it; send it to the active pane's shell instead. The text is
// pasted, never submitted.
function onStrayPaste(event: ClipboardEvent) {
  if (event.defaultPrevented || pasteHasOwnTarget(event.target)) return
  if (!terminalIsFocusedSurface()) return
  const text = event.clipboardData?.getData('text/plain')
  if (!text) return
  if (pasteIntoTerminalSession(activeTerminalPaneId(), text)) event.preventDefault()
}
window.addEventListener('paste', onStrayPaste)

function terminalIsFocusedSurface(): boolean {
  return (window as unknown as { __bsVim?: { focused?: string } }).__bsVim?.focused === 'terminal'
}

// Command+V fallback. WebKit sometimes delivers no paste event at all (the Edit
// menu route is lost after a focus change), or one whose clipboard has no
// text/plain (rich text, a copied file). Then the system clipboard is read
// natively and pasted through xterm's own paste, so bracketed paste still
// applies. A paste is never made twice: a native event seen after the
// keydown cancels the fallback, and one arriving just after a fallback is swallowed.
export const PASTE_FALLBACK_MS = 50
const FALLBACK_SWALLOW_MS = 500
let pasteSeen = 0
let fallbackPastedAt = -Infinity
let pasteTimer: ReturnType<typeof setTimeout> | null = null

/** The terminal pane a Command+V aimed at, or null when it is not a terminal paste. */
function pasteTargetPane(target: EventTarget | null): string | null {
  const node = target instanceof Node ? target : null
  const session = node ? terminalSessionForNode(node) : null
  if (session) return session.paneId
  if (pasteHasOwnTarget(target) || !terminalIsFocusedSurface()) return null
  return activeTerminalPaneId()
}

export async function pasteFromSystemClipboard(paneId: string): Promise<boolean> {
  let text: string | null = null
  try { text = await invoke<string | null>('clipboard_read_text') } catch { /* no native clipboard */ }
  if (!text) return false
  fallbackPastedAt = performance.now()
  return pasteIntoTerminalSession(paneId, text)
}

function onPasteKey(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'v' || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return
  const paneId = pasteTargetPane(event.target)
  if (!paneId) return
  const seenAtPress = pasteSeen
  if (pasteTimer) clearTimeout(pasteTimer)
  pasteTimer = setTimeout(() => {
    pasteTimer = null
    if (pasteSeen !== seenAtPress) return
    void pasteFromSystemClipboard(paneId)
  }, PASTE_FALLBACK_MS)
}

/** Text for a clipboard with no text/plain: dragged file URLs as quoted paths, else the visible text of rich text. */
export function textFromClipboardData(data: Pick<DataTransfer, 'getData'>): string {
  const plain = data.getData('text/plain')
  if (plain) return plain
  const uris = data.getData('text/uri-list').split(/\r?\n/).filter(line => line && !line.startsWith('#'))
  if (uris.length > 0 && uris.every(line => /^file:/i.test(line))) return uris.map(line => shellQuote(fileUrlToPath(line))).join(' ') + ' '
  const html = data.getData('text/html')
  return html ? new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '' : ''
}

function onPasteCapture(event: ClipboardEvent) {
  const since = performance.now() - fallbackPastedAt
  if (since >= 0 && since < FALLBACK_SWALLOW_MS) {
    // The fallback already pasted this very Command+V.
    event.preventDefault(); event.stopImmediatePropagation()
    return
  }
  pasteSeen++
  const data = event.clipboardData
  if (!data || data.getData('text/plain')) return
  const paneId = pasteTargetPane(event.target)
  if (!paneId) return
  event.preventDefault(); event.stopImmediatePropagation()
  const text = textFromClipboardData(data)
  if (text) pasteIntoTerminalSession(paneId, text)
  else void pasteFromSystemClipboard(paneId)
}
/** Test hook: forget a fallback paste and any pending one. */
export function __resetPasteFallbackForTest() {
  fallbackPastedAt = -Infinity
  if (pasteTimer) clearTimeout(pasteTimer)
  pasteTimer = null
}
window.addEventListener('keydown', onPasteKey, true)
window.addEventListener('paste', onPasteCapture, true)

export function inspectTerminalSession(paneId: string): Promise<TerminalLifecycleSnapshot | null> {
  return sessions.get(paneId)?.snapshot() ?? Promise.resolve(null)
}

function onDispose(event: Event) {
  const paneId = (event as CustomEvent<{ paneId: string }>).detail.paneId
  // Claim process cleanup so callers do not send a second kill for this ID.
  if (sessions.has(paneId)) event.preventDefault()
  disposeTerminalSession(paneId)
}
function onReleaseKeys(event: Event) {
  const keys = (event as CustomEvent<{ keys: string[] }>).detail.keys
  void Promise.resolve(invoke('pty_release_keys', { keys })).catch(() => { /* no terminal host */ })
}
window.addEventListener('terminal:release-keys', onReleaseKeys)
// The backend decides at quit whether kept shells are stopped; keep it told.
const syncKeepRunning = () => { void Promise.resolve(invoke('pty_set_keep_running', { keep: shouldKeepTerminalsRunning() })).catch(() => {}) }
syncKeepRunning()
subscribeSessionPreferences(syncKeepRunning)
window.addEventListener('terminal:dispose', onDispose)
// A module replacement is a development restart, not ordinary React navigation.
if (import.meta.hot) import.meta.hot.dispose(() => {
  window.removeEventListener('terminal:dispose', onDispose)
  for (const session of sessions.values()) session.dispose()
  sessions.clear()
})
