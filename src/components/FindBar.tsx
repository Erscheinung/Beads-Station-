// The find bar for terminal panes (Command+F) and the search across every pane
// of the workspace (Command+Shift+F). It owns the keyboard while it is open, so
// it also works in the alternate screen of agent TUIs and nvim, and Escape
// closes it and hands the cursor back to the terminal.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { compilePattern, matchLabel, searchSources, toHex, type FindOptions, type SearchResults, type SearchSource, type SearchHit, type SearchGroup } from '../lib/find'
import { findTerminalSession, type FindColors } from '../lib/terminalSessions'
import { closeFind, openFind, useFindState } from '../state/find'
import { revealPane, useTermPanes, workspaceLeaves, type Leaf } from '../state/termPanes'
import { setFocused } from '../state/vim'
import { readTranscript, turnText, type Transcript } from './designer/transcripts'
import { AGENT_CLI_LABEL } from '../state/agentHooks'

let lastQuery = ''
let lastOptions: FindOptions = { caseSensitive: false, regex: false }

function cssHex(name: string, fallback: string): string {
  try { return toHex(getComputedStyle(document.documentElement).getPropertyValue(name)) ?? fallback } catch { return fallback }
}
/** Match colours from the theme: the accent colours, the active match stronger. */
function findColors(): FindColors {
  return {
    match: cssHex('--bs-yellow', '#e0af68'), matchBorder: cssHex('--bs-yellow', '#e0af68'),
    active: cssHex('--bs-orange', '#ff9e64'), activeBorder: cssHex('--bs-fg', '#c0caf5'),
  }
}

const transcriptCache = new Map<string, Promise<string[]>>()
function conversationLines(leaf: Leaf): Promise<string[]> {
  const cli = leaf.agentCli
  const id = leaf.agentSessionId
  if (!cli || !id) return Promise.resolve([])
  const key = `${cli}:${id}`
  let cached = transcriptCache.get(key)
  if (!cached) {
    cached = Promise.resolve(readTranscript(leaf.cwd, cli, id))
      .then((result: Transcript) => result?.turns?.flatMap(turn => turnText(turn).split('\n')) ?? [])
      .catch(() => [])
    transcriptCache.set(key, cached)
    // A conversation grows while it runs; re-read it on the next search.
    setTimeout(() => transcriptCache.delete(key), 15_000)
  }
  return cached
}

function paneTitle(tabNumber: number, leaf: Leaf, suffix = ''): string {
  const folder = leaf.cwd.split('/').filter(Boolean).pop() ?? leaf.cwd
  return `Tab ${tabNumber} · ${folder}${leaf.agentCli ? ` · ${AGENT_CLI_LABEL[leaf.agentCli]}` : ''}${suffix}`
}

/** Every searchable thing in this workspace: live screens and scrollback, and agent conversations. */
async function collectSources(): Promise<SearchSource[]> {
  const sources: SearchSource[] = []
  for (const { tabNumber, leaf } of workspaceLeaves()) {
    const session = leaf.restored ? undefined : findTerminalSession(leaf.paneId)
    if (session) sources.push({ id: leaf.paneId, title: paneTitle(tabNumber, leaf), kind: 'terminal', lines: () => session.bufferLines() })
    if (leaf.agentCli && leaf.agentSessionId) {
      const lines = await conversationLines(leaf)
      if (lines.length) sources.push({ id: `${leaf.paneId}#conversation`, title: paneTitle(tabNumber, leaf, ' conversation'), kind: 'conversation', lines: () => lines })
    } else if (leaf.restored && leaf.savedScreen?.lines.length) {
      const lines = leaf.savedScreen.lines
      sources.push({ id: leaf.paneId, title: paneTitle(tabNumber, leaf, ' saved screen'), kind: 'terminal', lines: () => lines })
    }
  }
  return sources
}

export function FindBar() {
  const find = useFindState()
  const { tabs, activeTabId } = useTermPanes()
  if (!find.open) return null
  const tab = tabs.find(candidate => candidate.id === activeTabId) ?? tabs[0]
  const paneId = tab.activePaneId
  const target = document.querySelector(`[data-terminal-pane="${CSS.escape(paneId)}"], [data-restored-pane="${CSS.escape(paneId)}"]`)
    ?? document.querySelector('.bs-terminal-panes')
  if (!target) return null
  return createPortal(<FindBarBody mode={find.mode} paneId={paneId} epoch={find.epoch} />, target)
}

function FindBarBody({ mode, paneId, epoch }: { mode: 'pane' | 'workspace'; paneId: string; epoch: number }) {
  const [query, setQuery] = useState(lastQuery)
  const [options, setOptions] = useState<FindOptions>(lastOptions)
  const [count, setCount] = useState({ index: -1, count: 0 })
  const [results, setResults] = useState<SearchResults | null>(null)
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const session = mode === 'pane' ? findTerminalSession(paneId) : undefined
  const pattern = useMemo(() => compilePattern(query, options), [query, options])
  const error = query && !pattern.ok ? pattern.error : ''

  useEffect(() => { lastQuery = query; lastOptions = options }, [query, options])
  // Opening (or pressing the shortcut again) puts the cursor in the box.
  useEffect(() => {
    const frame = requestAnimationFrame(() => { input.current?.focus(); input.current?.select() })
    return () => cancelAnimationFrame(frame)
  }, [epoch, mode])

  // Pane mode: highlight every match in this pane's terminal, active one stronger.
  useEffect(() => {
    if (!session) return
    const stop = session.onFindResults(result => setCount(result))
    return () => { stop(); session.clearFind() }
  }, [session])
  useEffect(() => {
    if (!session) return
    if (!query || !pattern.ok) { session.clearFind(); setCount({ index: -1, count: 0 }); return }
    void session.find(query, options, 'next', findColors(), true).then(found => { if (!found) setCount({ index: -1, count: 0 }) })
  }, [session, query, options, pattern.ok])

  // Workspace mode: search every pane, a little after the last keystroke.
  useEffect(() => {
    if (mode !== 'workspace') return
    if (!query || !pattern.ok) { setResults(null); return }
    const signal = { cancelled: false }
    const timer = setTimeout(() => {
      void collectSources()
        .then(sources => searchSources(sources, pattern.pattern, { max: 200, signal }))
        .then(found => { if (!signal.cancelled) { setResults(found); setSelected(0) } })
    }, 120)
    return () => { signal.cancelled = true; clearTimeout(timer) }
  }, [mode, query, pattern])

  const step = useCallback((direction: 'next' | 'previous') => {
    if (!session || !query || !pattern.ok) return
    void session.find(query, options, direction, findColors())
  }, [session, query, options, pattern.ok])

  const close = useCallback(() => {
    // The terminal cannot take focus while an input still holds it.
    input.current?.blur()
    const terminal = findTerminalSession(paneId)
    closeFind()
    requestAnimationFrame(() => terminal?.focus())
  }, [paneId])

  const flat = useMemo(() => results?.groups.flatMap(group => group.hits.map(hit => ({ group, hit }))) ?? [], [results])
  const jump = (group: SearchGroup, hit: SearchHit) => {
    const targetPane = group.id.replace(/#conversation$/, '')
    revealPane(targetPane)
    setFocused('terminal')
    const restored = workspaceLeaves().find(entry => entry.leaf.paneId === targetPane)?.leaf.restored
    closeFind()
    if (group.kind === 'conversation' && restored) {
      window.dispatchEvent(new CustomEvent('find:conversation', { detail: { paneId: targetPane, query } }))
    } else if (group.kind === 'terminal') {
      // The pane may have to be re-attached after a tab change before it can scroll.
      setTimeout(() => findTerminalSession(targetPane)?.reveal(hit.line, hit.col, hit.length), 80)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (mode === 'workspace') {
      if (event.key === 'ArrowDown') { event.preventDefault(); setSelected(value => Math.min(flat.length - 1, value + 1)) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(value => Math.max(0, value - 1)) }
      else if (event.key === 'Enter') { event.preventDefault(); const choice = flat[selected]; if (choice) jump(choice.group, choice.hit) }
      return
    }
    if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? 'previous' : 'next') }
  }

  const label = mode === 'pane'
    ? (error || (session ? matchLabel(count.index, count.count, query) : query ? 'No terminal in this pane' : ''))
    : (error || (results ? `${results.total}${results.capped ? '+' : ''} result${results.total === 1 ? '' : 's'}` : ''))

  return <div className={`bs-findbar bs-findbar--${mode}`} role="search" aria-label={mode === 'pane' ? 'Find in pane' : 'Find in workspace'} data-testid="find-bar" onMouseDown={event => event.stopPropagation()}>
    <div className="bs-findbar__row">
      <input ref={input} className="bs-findbar__input" data-testid="find-input" aria-label="Find" placeholder={mode === 'pane' ? 'Find in pane' : 'Find in all panes'} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} spellCheck={false} autoComplete="off" />
      <span className={`bs-findbar__count${error ? ' bs-findbar__count--error' : ''}`} data-testid="find-count" aria-live="polite">{label}</span>
      {mode === 'pane' && <>
        <button type="button" className="bs-findbar__btn" aria-label="Previous match" title="Previous match (Shift+Enter)" onClick={() => step('previous')}>{'↑'}</button>
        <button type="button" className="bs-findbar__btn" aria-label="Next match" title="Next match (Enter)" onClick={() => step('next')}>{'↓'}</button>
      </>}
      <button type="button" className="bs-findbar__btn" aria-pressed={options.caseSensitive} aria-label="Match case" title="Match case" onClick={() => setOptions(value => ({ ...value, caseSensitive: !value.caseSensitive }))}>Aa</button>
      <button type="button" className="bs-findbar__btn" aria-pressed={options.regex} aria-label="Regular expression" title="Regular expression" onClick={() => setOptions(value => ({ ...value, regex: !value.regex }))}>.*</button>
      <button type="button" className="bs-findbar__btn bs-findbar__btn--wide" aria-pressed={mode === 'workspace'} title="Search every pane of this workspace" onClick={() => openFind(mode === 'pane' ? 'workspace' : 'pane')}>All panes</button>
      <button type="button" className="bs-findbar__btn" aria-label="Close find" title="Close (Esc)" onClick={close}>{'×'}</button>
    </div>
    {mode === 'workspace' && results && <div className="bs-findbar__results" data-testid="find-results" role="listbox" aria-label="Search results">
      {results.groups.length === 0 && <p className="bs-findbar__empty">Nothing found in this workspace.</p>}
      {results.groups.map(group => <section key={group.id} className="bs-findbar__group" data-testid="find-group">
        <h4>{group.title} <span>{group.hits.length}</span></h4>
        {group.hits.map((hit, i) => {
          const at = flat.findIndex(entry => entry.hit === hit)
          return <button key={i} type="button" role="option" aria-selected={at === selected} className={`bs-findbar__hit${at === selected ? ' bs-findbar__hit--selected' : ''}`} onClick={() => jump(group, hit)}>
            <span className="bs-findbar__line">{hit.line + 1}</span>
            <span className="bs-findbar__snippet">{hit.snippet.before}<mark className="bs-find-mark">{hit.snippet.match}</mark>{hit.snippet.after}</span>
          </button>
        })}
      </section>)}
    </div>}
  </div>
}
