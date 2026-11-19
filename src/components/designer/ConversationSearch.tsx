// Search box for a rendered conversation (restored pane, History): marks every
// match in place, counts them, and steps through them. The turns are drawn with
// `highlight` words by TurnView; this file finds the resulting <mark> elements.

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { matchLabel, queryWords, stepIndex } from '../../lib/find'

const ACTIVE = 'bs-find-mark--active'

export function useConversationFind(scroller: RefObject<HTMLElement | null>, query: string, renderKey: unknown) {
  const words = useMemo(() => queryWords(query), [query])
  const [state, setState] = useState({ count: 0, index: -1 })
  const index = useRef(-1)
  const lastQuery = useRef('')

  const marks = useCallback(() => Array.from(scroller.current?.querySelectorAll<HTMLElement>('mark.bs-find-mark') ?? []), [scroller])
  const activate = useCallback((list: HTMLElement[], at: number, scroll: boolean) => {
    list.forEach((mark, i) => mark.classList.toggle(ACTIVE, i === at))
    if (scroll && at >= 0) list[at]?.scrollIntoView?.({ block: 'center' })
  }, [])

  // After every render that could change the marks: recount, keep the active
  // one, and jump to the first match only when the query itself changed.
  useLayoutEffect(() => {
    const list = marks()
    const changed = lastQuery.current !== query
    lastQuery.current = query
    const at = list.length === 0 ? -1 : changed ? 0 : Math.min(Math.max(index.current, 0), list.length - 1)
    index.current = at
    activate(list, at, changed)
    setState(previous => previous.count === list.length && previous.index === at ? previous : { count: list.length, index: at })
  }, [query, renderKey, marks, activate])

  const step = useCallback((direction: 1 | -1) => {
    const list = marks()
    const at = stepIndex(index.current, list.length, direction)
    index.current = at
    activate(list, at, true)
    setState({ count: list.length, index: at })
  }, [marks, activate])

  return { words, count: state.count, index: state.index, next: () => step(1), prev: () => step(-1) }
}

export function ConversationSearch({ query, onQuery, count, index, onNext, onPrev, onlyMatching, onOnlyMatching, onEscape, style, inputStyle, type }: {
  query: string
  onQuery: (value: string) => void
  count: number
  index: number
  onNext: () => void
  onPrev: () => void
  onlyMatching: boolean
  onOnlyMatching: (value: boolean) => void
  /** Escape clears a non-empty query first, then hands focus back. */
  onEscape?: () => void
  style?: React.CSSProperties
  inputStyle?: React.CSSProperties
  type?: 'search' | 'text'
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); if (event.shiftKey) onPrev(); else onNext() }
    else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      if (query) onQuery(''); else onEscape?.()
    }
  }
  return <div className="bs-find-conv" style={style} data-find-scope>
    <input
      className="bs-find-conv__input"
      data-find-input
      type={type ?? 'search'}
      aria-label="Search this conversation"
      placeholder="Search (Cmd+F)"
      value={query}
      onChange={event => onQuery(event.target.value)}
      onKeyDown={onKeyDown}
      style={inputStyle}
      spellCheck={false}
      autoComplete="off"
    />
    {query && <span className="bs-find-conv__count" data-testid="conversation-find-count" aria-live="polite">{matchLabel(index, count, query)}</span>}
    <button type="button" className="bs-find-conv__btn" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={count === 0} onClick={onPrev}>{'↑'}</button>
    <button type="button" className="bs-find-conv__btn" aria-label="Next match" title="Next match (Enter)" disabled={count === 0} onClick={onNext}>{'↓'}</button>
    <label className="bs-find-conv__only" title="Hide turns that do not match">
      <input type="checkbox" checked={onlyMatching} onChange={event => onOnlyMatching(event.target.checked)} /> Only matching turns
    </label>
  </div>
}
