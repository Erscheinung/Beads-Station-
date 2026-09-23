import { describe, expect, it } from 'vitest'
import { captureChatViewport, restoreChatViewport, StreamFrameDeduper, type ChatViewMemory } from './ClaudeChat'

function memory(): ChatViewMemory {
  return {
    draft: '',
    selectionStart: 0,
    selectionEnd: 0,
    selectionDirection: 'none',
    followOutput: true,
    anchorId: null,
    anchorOffset: 0,
  }
}

function dimensions(element: HTMLElement, values: Record<string, number>) {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(element, key, { configurable: true, value })
  }
}

describe('ClaudeChat viewport memory', () => {
  it('drops the replay copy when a frame already arrived live', () => {
    const deduper = new StreamFrameDeduper(4)
    const frame = { _bs_seq: 12, type: 'assistant', message: { content: [] } }

    expect(deduper.accept(frame)).toBe(true)
    expect(deduper.accept({ ...frame })).toBe(false)
    expect(deduper.accept({ _bs_seq: 13, type: 'result' })).toBe(true)
    // Unstamped diagnostics remain visible; only the provider-owned sequence
    // is used as an identity because message text can legitimately repeat.
    expect(deduper.accept({ _kind: 'stderr', line: 'same text' })).toBe(true)
  })

  it('keeps a history reader on the same message when layout above it changes', () => {
    const scroll = document.createElement('div')
    const first = scroll.appendChild(document.createElement('div'))
    const anchor = scroll.appendChild(document.createElement('div'))
    first.dataset.bsChatAnchor = 'message:first'
    anchor.dataset.bsChatAnchor = 'message:anchor'
    dimensions(first, { offsetTop: 0, offsetHeight: 100 })
    dimensions(anchor, { offsetTop: 100, offsetHeight: 80 })
    dimensions(scroll, { scrollHeight: 500, clientHeight: 100 })
    scroll.scrollTop = 110
    const state = memory()

    captureChatViewport(scroll, state)
    expect(state).toMatchObject({ followOutput: false, anchorId: 'message:anchor', anchorOffset: -10 })

    dimensions(anchor, { offsetTop: 180, offsetHeight: 80 })
    scroll.scrollTop = 300
    restoreChatViewport(scroll, state)
    expect(scroll.scrollTop).toBe(190)
  })

  it('moves only a bottom follower to the new live bottom', () => {
    const scroll = document.createElement('div')
    dimensions(scroll, { scrollHeight: 500, clientHeight: 100 })
    scroll.scrollTop = 400
    const state = memory()
    captureChatViewport(scroll, state)
    expect(state.followOutput).toBe(true)

    dimensions(scroll, { scrollHeight: 650, clientHeight: 100 })
    restoreChatViewport(scroll, state)
    expect(scroll.scrollTop).toBe(550)
  })

  it('clamps gracefully when bounded history evicts the remembered message', () => {
    const scroll = document.createElement('div')
    dimensions(scroll, { scrollHeight: 300, clientHeight: 100 })
    scroll.scrollTop = 250
    const state = { ...memory(), followOutput: false, anchorId: 'evicted', anchorOffset: -4 }

    restoreChatViewport(scroll, state)

    expect(scroll.scrollTop).toBe(200)
  })
})
