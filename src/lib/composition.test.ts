import { afterEach, describe, expect, it } from 'vitest'
import { keepScrolledHome, resetHorizontalScroll } from './composition'

function scrollable(el: HTMLElement, left: number) {
  let value = left
  Object.defineProperty(el, 'scrollLeft', { get: () => value, set: next => { value = next }, configurable: true })
}

afterEach(() => { document.body.innerHTML = '' })

describe('keepScrolledHome', () => {
  it('puts every scrolled ancestor back while a composition runs', () => {
    const outer = document.createElement('main'); const pane = document.createElement('div')
    outer.append(pane); document.body.append(outer)
    scrollable(outer, 120)
    const stop = keepScrolledHome(pane)
    pane.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    pane.dispatchEvent(new Event('compositionupdate', { bubbles: true }))
    expect(outer.scrollLeft).toBe(0)
    stop()
  })
  it('does nothing outside a composition', () => {
    const outer = document.createElement('main'); const pane = document.createElement('div')
    outer.append(pane); document.body.append(outer)
    scrollable(outer, 50)
    const stop = keepScrolledHome(pane)
    pane.dispatchEvent(new Event('input', { bubbles: true }))
    expect(outer.scrollLeft).toBe(50)
    resetHorizontalScroll(pane)
    expect(outer.scrollLeft).toBe(0)
    stop()
  })
})
