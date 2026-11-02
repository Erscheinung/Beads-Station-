import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), released: vi.fn(), write: vi.fn(), refresh: vi.fn(),
  clearTextureAtlas: vi.fn(), disposed: vi.fn(), focus: vi.fn(), fit: vi.fn(),
  scrollToBottom: vi.fn(), scrollToLine: vi.fn(), markerDispose: vi.fn(), paste: vi.fn(),
  onScroll: null as null | (() => void), onWriteParsed: null as null | (() => void), onData: null as null | ((data: string) => void),
  onBell: null as null | (() => void), keyHandler: null as null | ((event: KeyboardEvent) => boolean),
  osc: new Map<number, (data: string) => boolean>(), scrollToTop: vi.fn(), notifyPane: vi.fn(), setPaneAgentCli: vi.fn(), setPaneAgentSession: vi.fn(), showInBrowserPane: vi.fn(() => true),
  themeListeners: new Set<() => void>(), selection: '', hostKey: null as string | null, pendingWrite: null as null | (() => void),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('./listenerRegistry', () => ({ safeListen: mock.listen }))
vi.mock('../state/theme', () => ({ getActivePalette: () => null, subscribeTheme: (listener: () => void) => { mock.themeListeners.add(listener); return () => mock.themeListeners.delete(listener) } }))
vi.mock('../state/paneNotifications', () => ({ notifyPane: mock.notifyPane }))
vi.mock('../state/termPanes', () => ({ setPaneAgentCli: mock.setPaneAgentCli, setPaneAgentSession: mock.setPaneAgentSession, isLocalUrl: (url: string) => url.includes('localhost'), showInBrowserPane: mock.showInBrowserPane, paneHostKey: () => mock.hostKey }))
vi.mock('xterm', () => ({ Terminal: class {
  options = {}; cols = 80; rows = 24
  buffer = {
    active: { type: 'normal', viewportY: 0, baseY: 0, cursorY: 0, cursorX: 0, length: 24, getLine: () => ({ translateToString: () => '' }) },
    normal: { type: 'normal', viewportY: 0, baseY: 0, cursorY: 0, cursorX: 0, length: 24 },
    alternate: { type: 'alternate', viewportY: 0, baseY: 0, cursorY: 0, cursorX: 0, length: 24 },
    onBufferChange() { return { dispose() {} } },
  }
  loadAddon() {} open() {} focus = mock.focus
  hasSelection() { return mock.selection !== '' }
  getSelection() { return mock.selection }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { mock.keyHandler = handler }
  onBell(handler: () => void) { mock.onBell = handler; return { dispose() {} } }
  parser = { registerOscHandler(ident: number, handler: (data: string) => boolean) { mock.osc.set(ident, handler); return { dispose() {} } } }
  scrollToTop = mock.scrollToTop
  write = mock.write; refresh = mock.refresh; clearTextureAtlas = mock.clearTextureAtlas; dispose = mock.disposed
  onData(handler: (data: string) => void) { mock.onData = handler; return { dispose() {} } }
  onScroll(handler: () => void) { mock.onScroll = handler; return { dispose() {} } }
  onWriteParsed(handler: () => void) { mock.onWriteParsed = handler; return { dispose() {} } }
  scrollToBottom = mock.scrollToBottom
  paste = mock.paste
  scrollToLine = mock.scrollToLine
  registerMarker(offset = 0) {
    const buffer = this.buffer.active
    return { id: 1, line: buffer.baseY + buffer.cursorY + offset, isDisposed: false, dispose: mock.markerDispose, onDispose() { return { dispose() {} } } }
  }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = mock.fit } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
import { setTerminalAppearance, resetTerminalAppearance } from '../state/terminalAppearance'
import { openTerminalLink, disposeTerminalSession, getTerminalSession, oscNotificationText, runInTerminalSession, SgrColorNormalizer, shellQuote, terminalFontStack, terminalSessionForNode } from './terminalSessions'

beforeEach(() => {
  vi.clearAllMocks()
  mock.selection = ''
  mock.hostKey = null
  mock.listen.mockResolvedValue(mock.released)
  mock.invoke.mockResolvedValue(7)
})
afterEach(() => { vi.useRealTimers(); disposeTerminalSession('pane'); resetTerminalAppearance(); mock.themeListeners.clear(); document.body.innerHTML = ''; vi.unstubAllGlobals() })

function userScroll(session: { element: HTMLElement }) {
  session.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
  mock.onScroll?.()
}

function visibleHost(width = 900, height = 400): HTMLDivElement {
  const host = document.body.appendChild(document.createElement('div'))
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON() {} })
  return host
}

describe('terminal session ownership', () => {
  it('reuses one shell and screen after detaching and reattaching the view', async () => {
    const spawned = vi.fn()
    const firstHost = document.body.appendChild(document.createElement('div'))
    const session = getTerminalSession('pane', '/repo', spawned)
    session.attach(firstHost)
    await session.ready
    session.detach(firstHost)
    expect(session.element.isConnected).toBe(true)
    expect(session.element.parentElement?.dataset.bsTerminalParking).toBe('true')
    const secondHost = document.body.appendChild(document.createElement('div'))
    const reattached = getTerminalSession('pane', '/repo', spawned)
    reattached.attach(secondHost)
    expect(reattached).toBe(session)
    expect(secondHost.firstChild).toBe(session.element)
    expect(mock.invoke.mock.calls.filter(([cmd]) => cmd === 'pty_spawn')).toHaveLength(1)
    expect(mock.listen.mock.invocationCallOrder[1]).toBeLessThan(mock.invoke.mock.invocationCallOrder[0])
    expect(mock.disposed).not.toHaveBeenCalled()
    expect(spawned).toHaveBeenCalledExactlyOnceWith('pane', 7)
    const [channel, onData] = mock.listen.mock.calls[0]
    expect(mock.invoke).toHaveBeenCalledWith('pty_spawn', expect.objectContaining({ eventKey: channel.replace('pty_data:', ''), cols: 80, rows: 24 }))
    onData({ payload: { id: 7, data: 'kept output' } })
    expect(mock.write).toHaveBeenCalledWith('kept output')
    expect(mock.refresh).toHaveBeenCalledWith(0, 23)
  })
  it('repaints the retained screen after the new host has a layout frame', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const firstHost = document.body.appendChild(document.createElement('div'))
    const session = getTerminalSession('pane', '/repo', vi.fn())
    session.attach(firstHost)
    session.detach(firstHost)
    const secondHost = document.body.appendChild(document.createElement('div'))
    session.attach(secondHost)
    await session.ready
    const repaintBeforeFrames = mock.refresh.mock.calls.length
    while (frames.length) frames.shift()!(0)
    expect(mock.refresh).toHaveBeenCalledTimes(repaintBeforeFrames + 1)
    expect(mock.refresh).toHaveBeenLastCalledWith(0, 23)
  })
  it('reapplies and repaints a detached session when the palette changes', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const session = getTerminalSession('pane', '/repo', vi.fn())
    session.attach(host)
    await session.ready
    const refreshBefore = mock.refresh.mock.calls.length
    const resizeBefore = mock.invoke.mock.calls.filter(([cmd]) => cmd === 'pty_resize').length

    mock.themeListeners.forEach(listener => listener())

    expect(mock.refresh.mock.calls.length).toBeGreaterThan(refreshBefore)
    expect(mock.invoke.mock.calls.filter(([cmd]) => cmd === 'pty_resize')).toHaveLength(resizeBefore + 1)
    expect(session.terminal.options.theme).toEqual(expect.objectContaining({ background: '#1f2335' }))
  })
  it('resizes the native shell when layout changes while spawn is pending', async () => {
    let complete!: (id: number) => void
    mock.invoke.mockImplementation(cmd => cmd === 'pty_spawn' ? new Promise<number>(resolve => { complete = resolve }) : Promise.resolve())
    const session = getTerminalSession('pane', '/repo', vi.fn())
    const host = visibleHost()
    session.attach(host)
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    Object.assign(session.terminal, { cols: 100, rows: 30 })
    session.resize()
    expect(mock.invoke).not.toHaveBeenCalledWith('pty_resize', expect.anything())
    complete(7)
    await session.ready
    expect(mock.invoke).toHaveBeenCalledWith('pty_resize', { id: 7, cols: 100, rows: 30 })
  })
  it('never fits or resizes a detached session against the 1px parking host', async () => {
    const host = visibleHost()
    const session = getTerminalSession('pane', '/repo', vi.fn())
    session.attach(host)
    await session.ready
    session.detach(host)
    mock.fit.mockClear()
    mock.invoke.mockClear()

    setTerminalAppearance({ fontSize: 14 })

    expect(mock.fit).not.toHaveBeenCalled()
    expect(mock.invoke).not.toHaveBeenCalledWith('pty_resize', expect.anything())
    expect(session.element.parentElement?.dataset.bsTerminalParking).toBe('true')
  })
  it('keeps a history reader anchored by buffer identity across a fit', async () => {
    const host = visibleHost()
    const session = getTerminalSession('pane', '/repo', vi.fn())
    session.attach(host)
    await session.ready
    const buffer = session.terminal.buffer.active as unknown as { type: 'normal'; viewportY: number; baseY: number; cursorY: number }
    Object.assign(buffer, { viewportY: 40, baseY: 100, cursorY: 10 })
    userScroll(session)
    mock.fit.mockImplementationOnce(() => {
      Object.assign(buffer, { viewportY: 80, baseY: 120 })
    })

    session.resize(host)

    expect(mock.scrollToLine).toHaveBeenLastCalledWith(40)
    expect(mock.scrollToBottom).not.toHaveBeenCalled()
  })
  it('follows live output conditionally and leaves alternate-screen viewport ownership alone', async () => {
    const host = visibleHost()
    const session = getTerminalSession('pane', '/repo', vi.fn())
    session.attach(host)
    await session.ready
    const terminal = session.terminal as unknown as { buffer: { active: { type: 'normal' | 'alternate'; viewportY: number; baseY: number; cursorY: number } } }
    Object.assign(terminal.buffer.active, { type: 'normal', viewportY: 100, baseY: 100, cursorY: 5 })
    userScroll(session)
    mock.fit.mockImplementationOnce(() => Object.assign(terminal.buffer.active, { viewportY: 100, baseY: 120 }))
    session.resize(host)
    expect(mock.scrollToBottom).toHaveBeenCalledTimes(1)

    terminal.buffer.active = { type: 'alternate', viewportY: 0, baseY: 0, cursorY: 3 }
    mock.scrollToBottom.mockClear()
    mock.scrollToLine.mockClear()
    session.resize(host)
    expect(mock.scrollToBottom).not.toHaveBeenCalled()
    expect(mock.scrollToLine).not.toHaveBeenCalled()
  })
  it('keeps a history reader in place when output (not the user) scrolls to the bottom', async () => {
    const host = visibleHost()
    const session = getTerminalSession('pane', '/repo', vi.fn())
    session.attach(host)
    await session.ready
    const buffer = session.terminal.buffer.active as unknown as { viewportY: number; baseY: number; cursorY: number }
    Object.assign(buffer, { viewportY: 40, baseY: 100, cursorY: 10 })
    userScroll(session)
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 5000)

    // A TUI clears scrollback and reprints: xterm reports a scroll that lands
    // on the live bottom without any user gesture.
    Object.assign(buffer, { viewportY: 130, baseY: 130 })
    mock.onScroll?.()
    mock.onWriteParsed?.()

    expect(mock.scrollToBottom).not.toHaveBeenCalled()
    expect(mock.scrollToLine).toHaveBeenLastCalledWith(40)
    expect((await session.snapshot()).viewport.followOutput).toBe(false)
  })
  it('returns to following live output when the user types or scrolls back down', async () => {
    const host = visibleHost()
    const session = getTerminalSession('pane', '/repo', vi.fn())
    session.attach(host)
    await session.ready
    const buffer = session.terminal.buffer.active as unknown as { viewportY: number; baseY: number; cursorY: number }
    Object.assign(buffer, { viewportY: 40, baseY: 100, cursorY: 10 })
    userScroll(session)
    expect((await session.snapshot()).viewport.followOutput).toBe(false)

    mock.onData?.('x')
    expect((await session.snapshot()).viewport.followOutput).toBe(true)

    Object.assign(buffer, { viewportY: 40, baseY: 100 })
    userScroll(session)
    Object.assign(buffer, { viewportY: 100, baseY: 100 })
    userScroll(session)
    expect((await session.snapshot()).viewport.followOutput).toBe(true)
  })
  it('does not steal focus from a dialog or another editable', async () => {
    const session = getTerminalSession('pane', '/repo', vi.fn())
    session.attach(visibleHost())
    await session.ready
    const dialog = document.body.appendChild(document.createElement('dialog'))
    dialog.setAttribute('open', '')
    const input = dialog.appendChild(document.createElement('input'))
    input.focus()
    expect(session.focus()).toBe(false)
    dialog.remove()
    const other = document.body.appendChild(document.createElement('input'))
    other.focus()
    expect(session.focus()).toBe(false)
    other.remove()
    document.body.focus()
    expect(session.focus()).toBe(true)
    expect(mock.focus).toHaveBeenCalledTimes(1)
  })
  it('does not spawn if output subscription fails', async () => {
    mock.listen.mockRejectedValueOnce(new Error('listener unavailable'))
    const session = getTerminalSession('pane', '/repo', vi.fn())
    await session.ready
    expect(session.phase).toBe('error')
    expect(mock.invoke).not.toHaveBeenCalled()
  })
  it('kills a pending spawn when its pane is explicitly closed', async () => {
    let complete!: (id: number) => void
    mock.invoke.mockImplementation(cmd => cmd === 'pty_spawn' ? new Promise<number>(resolve => { complete = resolve }) : Promise.resolve())
    const spawned = vi.fn()
    const session = getTerminalSession('pane', '/repo', spawned)
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    disposeTerminalSession('pane')
    complete(9)
    await session.ready
    expect(mock.invoke).toHaveBeenCalledWith('pty_kill', { id: 9 })
    expect(spawned).not.toHaveBeenCalled()
    expect(mock.released).toHaveBeenCalledTimes(2)
  })
  it('does not label a fast-exiting shell as running when spawn resolves later', async () => {
    mock.invoke.mockImplementation(async cmd => {
      if (cmd === 'pty_spawn') mock.listen.mock.calls[1][1]({ payload: { id: 7 } })
      return 7
    })
    const session = getTerminalSession('pane', '/repo', vi.fn())
    await session.ready
    expect(session.phase).toBe('exited')
  })
})

describe('Neovim truecolor output', () => {
  it('normalizes colon-form RGB and indexed SGR for xterm 5.3', () => {
    const normalizer = new SgrColorNormalizer()
    expect(normalizer.push('\u001b[38:2:200:211:245mforeground\u001b[48:2:34:36:54mbackground\u001b[0m'))
      .toBe('\u001b[38;2;200;211;245mforeground\u001b[48;2;34;36;54mbackground\u001b[0m')
    expect(normalizer.push('\u001b[38:5:196mred')).toBe('\u001b[38;5;196mred')
  })

  it('keeps an RGB sequence intact when PTY reads split it between bytes', () => {
    const normalizer = new SgrColorNormalizer()
    const chunks = ['\u001b[38:2:200', ':211:245mblue', '\u001b[48:2:34:36', ':54mcanvas']
    expect(chunks.map(chunk => normalizer.push(chunk)).join('') + normalizer.finish())
      .toBe('\u001b[38;2;200;211;245mblue\u001b[48;2;34;36;54mcanvas')
  })

  it('flushes a non-colour incomplete escape sequence verbatim on exit', () => {
    const normalizer = new SgrColorNormalizer()
    expect(normalizer.push('output\u001b[38:2:1')).toBe('output')
    expect(normalizer.finish()).toBe('\u001b[38:2:1')
  })
})

it('updates cursor and bounded scrollback in a detached terminal without respawning the shell', async () => {
  const session = getTerminalSession('pane', '/repo', vi.fn())
  await session.ready
  setTerminalAppearance({ cursorStyle: 'bar', cursorBlink: false, scrollback: 5000 })
  expect(session.terminal.options).toMatchObject({ cursorStyle: 'bar', cursorBlink: false, scrollback: 5000 })
  setTerminalAppearance({ scrollback: Infinity, fontSize: -10 })
  expect(session.terminal.options).toMatchObject({ scrollback: 5000, fontSize: 13 })
  expect(mock.invoke.mock.calls.filter(([cmd]) => cmd === 'pty_spawn')).toHaveLength(1)
  resetTerminalAppearance()
})

describe('dropped file paths', () => {
  it('quotes only paths the shell would split or expand', () => {
    expect(shellQuote('/Users/me/src/app.ts')).toBe('/Users/me/src/app.ts')
    expect(shellQuote('/Users/me/My Files/a b.png')).toBe("'/Users/me/My Files/a b.png'")
    expect(shellQuote("/tmp/it's $HOME")).toBe("'/tmp/it'\\''s $HOME'")
  })
  it('pastes quoted paths into the session under the drop point without executing them', async () => {
    const host = visibleHost()
    const session = getTerminalSession('pane', '/repo', vi.fn())
    session.attach(host)
    await session.ready
    const child = session.element.appendChild(document.createElement('canvas'))
    expect(terminalSessionForNode(child)).toBe(session)
    expect(session.pastePaths(['/a/b.txt', '/c d/e.png'])).toBe(true)
    expect(mock.paste).toHaveBeenCalledWith("/a/b.txt '/c d/e.png' ")
    expect(terminalSessionForNode(document.body)).toBeNull()
  })
})

describe('native resize coalescing', () => {
  it('sends one native resize for a burst of layout changes, with the settled size', async () => {
    const host = visibleHost()
    const session = getTerminalSession('pane', '/repo', vi.fn())
    session.attach(host)
    await session.ready
    vi.useFakeTimers()
    mock.invoke.mockClear()
    for (const cols of [90, 95, 101, 110]) {
      Object.assign(session.terminal, { cols, rows: 30 })
      session.resize(host)
    }
    expect(mock.invoke).not.toHaveBeenCalledWith('pty_resize', expect.anything())
    vi.advanceTimersByTime(200)
    expect(mock.invoke.mock.calls.filter(([cmd]) => cmd === 'pty_resize')).toEqual([['pty_resize', { id: 7, cols: 110, rows: 30 }]])
    // Settling back on the size the shell already has sends nothing.
    session.resize(host)
    vi.advanceTimersByTime(200)
    expect(mock.invoke.mock.calls.filter(([cmd]) => cmd === 'pty_resize')).toHaveLength(1)
  })
})

describe('pane notification sources', () => {
  it('reads OSC 9, 99 and 777 notification text and ignores progress reports', () => {
    expect(oscNotificationText(9, 'Build finished')).toBe('Build finished')
    expect(oscNotificationText(9, '4;1;50')).toBeNull()
    expect(oscNotificationText(777, 'notify;Claude Code;Waiting for your input')).toBe('Claude Code: Waiting for your input')
    expect(oscNotificationText(777, 'precmd;x')).toBeNull()
    expect(oscNotificationText(99, 'i=1:d=0;Tests passed')).toBe('Tests passed')
    expect(oscNotificationText(99, 'i=1:p=body;All green')).toBe('All green')
    expect(oscNotificationText(99, 'i=1:p=close;')).toBeNull()
  })
  it('notifies its pane on a bell or an OSC notification', async () => {
    const session = getTerminalSession('pane', '/repo', vi.fn())
    await session.ready
    mock.onBell?.()
    expect(mock.notifyPane).toHaveBeenLastCalledWith('pane', 'bell')
    expect(mock.osc.get(9)?.('Deploy done')).toBe(true)
    expect(mock.notifyPane).toHaveBeenLastCalledWith('pane', 'osc', 'Deploy done')
    expect(mock.osc.get(9)?.('4;0')).toBe(false)
    expect(mock.notifyPane).toHaveBeenCalledTimes(2)
  })
  it('reports sustained output that goes quiet, but not a short burst or typing echo', async () => {
    let now = 10_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.useFakeTimers()
    const session = getTerminalSession('pane', '/repo', vi.fn())
    await session.ready
    const output = mock.listen.mock.calls[0][1] as (event: { payload: { id: number; data: string } }) => void
    const emit = (advance: number) => { now += advance; vi.advanceTimersByTime(advance); output({ payload: { id: 7, data: 'x' } }) }

    // A two-second burst is not "work".
    emit(0); emit(1000); emit(1000)
    now += 4000; vi.advanceTimersByTime(4000)
    expect(mock.notifyPane).not.toHaveBeenCalled()

    // Echo of the user's own typing is ignored however long it lasts.
    for (let index = 0; index < 8; index += 1) { mock.onData?.('a'); emit(100); now += 900; vi.advanceTimersByTime(900) }
    now += 4000; vi.advanceTimersByTime(4000)
    expect(mock.notifyPane).not.toHaveBeenCalled()

    // Five seconds of continuous output followed by silence is.
    emit(0); for (let index = 0; index < 5; index += 1) emit(1000)
    now += 2000; vi.advanceTimersByTime(2000)
    expect(mock.notifyPane).not.toHaveBeenCalled()
    now += 1500; vi.advanceTimersByTime(1500)
    expect(mock.notifyPane).toHaveBeenCalledExactlyOnceWith('pane', 'quiet')
  })
})

describe('terminal keys and fonts', () => {
  const press = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init })
  it('sends macOS editing chords once, on keydown, and lets the setting turn them off', async () => {
    const session = getTerminalSession('pane', '/repo', vi.fn())
    await session.ready
    mock.invoke.mockClear()
    const event = press({ key: 'ArrowLeft', metaKey: true })
    expect(mock.keyHandler?.(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(mock.keyHandler?.(new KeyboardEvent('keyup', { key: 'ArrowLeft', metaKey: true }))).toBe(false)
    await vi.waitFor(() => expect(mock.invoke.mock.calls.filter(([cmd]) => cmd === 'pty_write')).toEqual([['pty_write', { id: 7, data: '\u0001' }]]))

    expect(mock.keyHandler?.(press({ key: 'ArrowUp', metaKey: true }))).toBe(false)
    expect(mock.scrollToTop).toHaveBeenCalledTimes(1)
    expect(mock.keyHandler?.(press({ key: 'a' }))).toBe(true)

    setTerminalAppearance({ macEditingKeys: false })
    expect(mock.keyHandler?.(press({ key: 'ArrowLeft', metaKey: true }))).toBe(true)
  })
  it('keeps app shortcuts ahead of terminal chords', async () => {
    const session = getTerminalSession('pane', '/repo', vi.fn())
    await session.ready
    mock.invoke.mockClear()
    // Mod+Shift+ArrowLeft is "Focus terminal pane left".
    expect(mock.keyHandler?.(press({ key: 'ArrowLeft', metaKey: true, shiftKey: true }))).toBe(false)
    expect(mock.invoke).not.toHaveBeenCalledWith('pty_write', expect.anything())
  })
  it('puts the bundled Nerd Font behind every terminal font choice', async () => {
    expect(terminalFontStack('Menlo')).toBe("Menlo, 'JetBrainsMono Nerd Font', monospace")
    const session = getTerminalSession('pane', '/repo', vi.fn())
    await session.ready
    expect(session.terminal.options.fontFamily).toBe("'JetBrains Mono', 'JetBrainsMono Nerd Font', monospace")
    setTerminalAppearance({ fontFamily: 'monospace' })
    expect(session.terminal.options.fontFamily).toBe("monospace, 'JetBrainsMono Nerd Font', monospace")
  })
})

describe('terminal copy', () => {
  function clipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText }, platform: navigator.platform })
    return writeText
  }
  function drag(session: { element: HTMLElement }) {
    session.element.dispatchEvent(new Event('pointerdown'))
    window.dispatchEvent(new Event('pointerup'))
  }

  it('copies a finished mouse selection, and only when the setting is on', () => {
    const writeText = clipboard()
    const session = getTerminalSession('pane', '/tmp', vi.fn())
    drag(session)
    expect(writeText).not.toHaveBeenCalled()

    mock.selection = 'git status'
    drag(session)
    expect(writeText).toHaveBeenCalledWith('git status')

    setTerminalAppearance({ copyOnSelect: false })
    drag(session)
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('copies the selection on Cmd+C and leaves Cmd+C alone without one', () => {
    const writeText = clipboard()
    getTerminalSession('pane', '/tmp', vi.fn())
    const copy = () => mock.keyHandler!(new KeyboardEvent('keydown', { key: 'c', metaKey: true }))
    expect(copy()).toBe(true)
    expect(writeText).not.toHaveBeenCalled()
    mock.selection = 'pwd'
    expect(copy()).toBe(false)
    expect(writeText).toHaveBeenCalledWith('pwd')
  })
})

describe('kept terminals', () => {
  it('asks for an ordinary shell unless the pane has a key', async () => {
    const session = getTerminalSession('pane', '/repo', vi.fn())
    await session.ready
    expect(mock.invoke).toHaveBeenCalledWith('pty_spawn', expect.objectContaining({ persistKey: null }))
    disposeTerminalSession('pane')
    mock.hostKey = '2c975569-13c1-43b2-8e7a-f88d6138d7d8'
    await getTerminalSession('pane', '/repo', vi.fn()).ready
    expect(mock.invoke).toHaveBeenLastCalledWith('pty_spawn', expect.objectContaining({ persistKey: mock.hostKey }))
  })
  it('replayed history raises no notification and cancels a queued command', async () => {
    const session = getTerminalSession('pane', '/repo', vi.fn())
    await session.ready
    mock.write.mockImplementation((_data: string, done?: () => void) => { mock.pendingWrite = done ?? null })
    runInTerminalSession('pane', 'claude --continue')
    vi.useFakeTimers()
    mock.invoke.mockClear()
    mock.listen.mock.calls[0][1]({ payload: { id: 7, data: 'old output\u0007', replay: true } })
    // While the replay is being parsed, its bell and notifications are history.
    mock.onBell!()
    expect(mock.osc.get(777)!('notify;Claude Code;Finished')).toBe(true)
    expect(mock.notifyPane).not.toHaveBeenCalled()
    mock.pendingWrite!()
    await vi.advanceTimersByTimeAsync(2000)
    expect(mock.invoke).not.toHaveBeenCalledWith('pty_write', expect.anything())
    // Live output afterwards notifies as usual.
    mock.onBell!()
    expect(mock.notifyPane).toHaveBeenCalledWith('pane', 'bell')
  })
})

describe('links in terminal output', () => {
  it('opens an address on this machine in a browser pane and anything else outside', () => {
    const open = vi.fn(() => null)
    vi.stubGlobal('open', open)
    openTerminalLink('http://localhost:5173/')
    expect(mock.showInBrowserPane).toHaveBeenCalledWith('http://localhost:5173/')
    expect(open).not.toHaveBeenCalled()
    mock.showInBrowserPane.mockClear()
    openTerminalLink('https://example.com/docs')
    expect(mock.showInBrowserPane).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
  })
})

describe('agent CLI resume support', () => {
  it('records the foreground agent CLI at each screen checkpoint', async () => {
    mock.invoke.mockImplementation(async cmd => cmd === 'pty_foreground' ? { cli: 'claude', sessionId: null } : 7)
    const session = getTerminalSession('pane', '/repo', vi.fn(), vi.fn())
    await session.ready
    session.checkpointScreen()
    await vi.waitFor(() => expect(mock.setPaneAgentCli).toHaveBeenLastCalledWith('pane', 'claude'))
    mock.invoke.mockImplementation(async cmd => cmd === 'pty_foreground' ? { cli: null, sessionId: null } : 7)
    session.checkpointScreen()
    await vi.waitFor(() => expect(mock.setPaneAgentCli).toHaveBeenLastCalledWith('pane', null))
  })
  it('asks for the Codex session until it is known, and records it', async () => {
    const id = '01a12f2b-69d8-7ea0-a23b-0fd1d81cac0e'
    let answer: unknown = { cli: 'codex', sessionId: null }
    mock.invoke.mockImplementation(async cmd => cmd === 'pty_foreground' ? answer : 7)
    const session = getTerminalSession('pane', '/repo', vi.fn(), vi.fn())
    await session.ready
    const asked = () => mock.invoke.mock.calls.filter(([cmd]) => cmd === 'pty_foreground').map(([, args]) => (args as { wantSession: boolean }).wantSession)
    session.checkpointScreen()
    await vi.waitFor(() => expect(mock.setPaneAgentCli).toHaveBeenLastCalledWith('pane', 'codex'))
    answer = { cli: 'codex', sessionId: id }
    session.checkpointScreen()
    await vi.waitFor(() => expect(mock.setPaneAgentSession).toHaveBeenCalledWith('pane', 'codex', id))
    session.checkpointScreen()
    await vi.waitFor(() => expect(asked()).toEqual([false, true, false]))
  })
  it('records the session a Claude Code hook reports, and ignores a malformed one', async () => {
    getTerminalSession('pane', '/repo', vi.fn())
    const report = mock.osc.get(7770)!
    expect(report('session;claude;not-an-id')).toBe(true)
    expect(report('session;codex;2c975569-13c1-43b2-8e7a-f88d6138d7d8')).toBe(true)
    expect(mock.setPaneAgentSession).not.toHaveBeenCalled()
    report('session;claude;2c975569-13c1-43b2-8e7a-f88d6138d7d8')
    expect(mock.setPaneAgentSession).toHaveBeenCalledWith('pane', 'claude', '2c975569-13c1-43b2-8e7a-f88d6138d7d8')
  })
  it('types a requested startup command only after the shell has printed', async () => {
    const session = getTerminalSession('pane', '/repo', vi.fn())
    await session.ready
    vi.useFakeTimers()
    mock.invoke.mockClear()
    runInTerminalSession('pane', 'claude --continue')
    vi.advanceTimersByTime(2000)
    expect(mock.invoke).not.toHaveBeenCalledWith('pty_write', expect.anything())
    mock.listen.mock.calls[0][1]({ payload: { id: 7, data: 'prompt % ' } })
    vi.advanceTimersByTime(500)
    await vi.runAllTimersAsync()
    expect(mock.invoke.mock.calls.filter(([cmd]) => cmd === 'pty_write')).toEqual([['pty_write', { id: 7, data: 'claude --continue\r' }]])
  })
})
