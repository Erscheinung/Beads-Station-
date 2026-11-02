import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPointerDrag } from './pointerDrag'

function pointer(type: string, buttons: number) {
  const event = new MouseEvent(type, { buttons, clientX: 10, clientY: 10 })
  window.dispatchEvent(event)
}

afterEach(() => pointer('pointerup', 0))

describe('pointer drags', () => {
  it('ends when a move arrives with no button held, as after a release over a frame', () => {
    const onMove = vi.fn()
    const onEnd = vi.fn()
    startPointerDrag({ onMove, onEnd })
    expect(document.documentElement.classList.contains('bs-dragging')).toBe(true)
    pointer('pointermove', 1)
    pointer('pointermove', 0)
    pointer('pointermove', 1)
    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(document.documentElement.classList.contains('bs-dragging')).toBe(false)
  })

  it('ends when the window loses focus', () => {
    const onEnd = vi.fn()
    startPointerDrag({ onMove: () => {}, onEnd })
    window.dispatchEvent(new Event('blur'))
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
})
