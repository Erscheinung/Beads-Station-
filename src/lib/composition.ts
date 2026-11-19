/**
 * macOS dictation and IME composition can make the browser scroll an ancestor of
 * the terminal sideways to keep the (hidden) caret in view. A terminal never
 * scrolls horizontally, so while a composition is running every ancestor that
 * moved is put back. Idle terminals cost nothing: the listeners only act between
 * `compositionstart` and `compositionend`.
 */
export function resetHorizontalScroll(from: Element): void {
  for (let node: Element | null = from; node; node = node.parentElement) {
    if (node.scrollLeft !== 0) node.scrollLeft = 0
  }
  const root = document.scrollingElement
  if (root && root.scrollLeft !== 0) root.scrollLeft = 0
}

export function keepScrolledHome(element: HTMLElement): () => void {
  let composing = false
  let frame = 0
  const settle = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; resetHorizontalScroll(element) }) }
  const start = () => { composing = true }
  const end = () => { composing = false; settle() }
  const update = () => { if (composing) { resetHorizontalScroll(element); settle() } }
  // Scroll events do not bubble, but they can be captured on the way down.
  const scrolled = () => { if (composing) resetHorizontalScroll(element) }
  element.addEventListener('compositionstart', start, true)
  element.addEventListener('compositionupdate', update, true)
  element.addEventListener('compositionend', end, true)
  element.addEventListener('input', update, true)
  window.addEventListener('scroll', scrolled, true)
  return () => {
    element.removeEventListener('compositionstart', start, true)
    element.removeEventListener('compositionupdate', update, true)
    element.removeEventListener('compositionend', end, true)
    element.removeEventListener('input', update, true)
    window.removeEventListener('scroll', scrolled, true)
    if (frame) cancelAnimationFrame(frame)
  }
}
