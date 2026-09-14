import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), released: vi.fn(), write: vi.fn(), refresh: vi.fn(), clearTextureAtlas: vi.fn(), disposed: vi.fn(), themeListeners: new Set<() => void>() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('./listenerRegistry', () => ({ safeListen: mock.listen }))
vi.mock('../state/theme', () => ({ getActivePalette: () => null, subscribeTheme: (listener: () => void) => { mock.themeListeners.add(listener); return () => mock.themeListeners.delete(listener) } }))
vi.mock('xterm', () => ({ Terminal: class {
  options = {}; cols = 80; rows = 24
  loadAddon() {} open() {} focus() {}
  attachCustomKeyEventHandler() {}
  write = mock.write; refresh = mock.refresh; clearTextureAtlas = mock.clearTextureAtlas; dispose = mock.disposed
  onData() { return { dispose() {} } }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
import { setTerminalAppearance, resetTerminalAppearance } from '../state/terminalAppearance'
import { disposeTerminalSession, getTerminalSession, SgrColorNormalizer } from './terminalSessions'

beforeEach(() => {
  vi.clearAllMocks()
  mock.listen.mockResolvedValue(mock.released)
  mock.invoke.mockResolvedValue(7)
})
afterEach(() => { disposeTerminalSession('pane'); mock.themeListeners.clear(); document.body.innerHTML = '' })

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
    vi.unstubAllGlobals()
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
    session.attach(document.body.appendChild(document.createElement('div')))
    Object.defineProperties(session.element, { clientWidth: { value: 900 }, clientHeight: { value: 400 } })
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    Object.assign(session.terminal, { cols: 100, rows: 30 })
    session.resize()
    expect(mock.invoke).not.toHaveBeenCalledWith('pty_resize', expect.anything())
    complete(7)
    await session.ready
    expect(mock.invoke).toHaveBeenCalledWith('pty_resize', { id: 7, cols: 100, rows: 30 })
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
