import { describe, expect, it } from 'vitest'
import { captureChatViewport, restoreChatViewport, type ChatViewMemory } from './ClaudeChat'

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
