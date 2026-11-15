import { useEffect, useMemo, useState } from 'react'
import { BdLiveProvider } from '../../lib/BdLiveProvider'
import { useBdSnapshot } from '../../lib/bdCache'
import { useProjects } from '../../state/projects'
import type { Issue } from '../../types/issue'
import { beadRelations, type BeadState } from './beadMap'
import { PRIORITY_LABEL } from './beadPresentation'
import { useSessionTree } from './useSessionTree'
import { buildBoard, hiddenTotal, LIMIT_STEP, liveBeadIds, type BoardEntry, type Density, type Lens } from './requestBoardLogic'

const COLUMNS: { state: BeadState; title: string; empty: string }[] = [
  { state: 'ready', title: 'Ready to start', empty: 'Nothing is waiting to start.' },
  { state: 'in_progress', title: 'In progress', empty: 'Nothing is being worked on.' },
  { state: 'blocked', title: 'Waiting on something', empty: 'Nothing is stuck.' },
  { state: 'closed', title: 'Done', empty: 'Finished requests appear here.' },
]
const PRIORITY_CHIPS: { value: number; label: string }[] = [
  { value: 0, label: 'P0' }, { value: 1, label: 'P1' }, { value: 2, label: 'P2' }, { value: 3, label: 'P3+' },
]

/** A remembered per-viewer choice; storage can throw or be empty, so the default always works. */
function useStored<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try { const saved = localStorage.getItem(key); return allowed.includes(saved as T) ? (saved as T) : fallback } catch { return fallback }
  })
  return [value, next => { setValue(next); try { localStorage.setItem(key, next) } catch { /* not remembered */ } }]
}

function BoardInner({ repoPath, onOpen }: { repoPath: string; onOpen: (issue: Issue) => void }) {
  const snap = useBdSnapshot(repoPath)
  const [query, setQuery] = useState('')
  const [lens, setLens] = useStored<Lens>('bs.requestBoard.lens', 'focus', ['focus', 'all'])
  const [density, setDensity] = useStored<Density>('bs.requestBoard.density', 'comfortable', ['comfortable', 'compact'])
  const [priorities, setPriorities] = useState<ReadonlySet<number>>(() => new Set())
  const [liveOnly, setLiveOnly] = useState(false)
  const [limits, setLimits] = useState<Partial<Record<BeadState, number>>>({})
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const readyIds = useMemo(() => new Set(snap.ready.map(issue => issue.id)), [snap.ready])
  const relations = useMemo(() => beadRelations(snap.all), [snap.all])
  const byId = useMemo(() => new Map(snap.all.map(issue => [issue.id, issue])), [snap.all])
  const openIds = useMemo(() => snap.all.filter(issue => issue.status !== 'closed').map(issue => issue.id), [snap.all])
  const { tree } = useSessionTree(repoPath, openIds)
  const live = useMemo(() => liveBeadIds(tree), [tree])
  // A new view of the data starts from the short list again.
  useEffect(() => { setLimits({}) }, [lens, query, priorities, liveOnly])
  const view = useMemo(
    () => buildBoard({ issues: snap.all, readyIds, relations, live, filters: { lens, query, priorities, liveOnly }, limits }),
    [snap.all, readyIds, relations, live, lens, query, priorities, liveOnly, limits],
  )

  if (!snap.loaded) return <div className="du-map__hint">Loading requests…</div>
  if (snap.error) return <div className="du-map__hint">bd error: {snap.error}</div>
  const hidden = hiddenTotal(view)
  const toggle = <K,>(set: ReadonlySet<K>, item: K): Set<K> => { const next = new Set(set); if (next.has(item)) next.delete(item); else next.add(item); return next }

  const card = (issue: Issue, state: BeadState, nested = false) => {
    const parent = relations.get(issue.id)?.parent
    const waiting = relations.get(issue.id)?.blockedBy.filter(id => byId.get(id)?.status !== 'closed').length ?? 0
    const isLiveNow = live.has(issue.id)
    return <button key={issue.id} className={`du-card du-card--${state}${density === 'compact' ? ' du-card--compact' : ''}${nested ? ' du-card--nested' : ''}`} data-bs-bead-node={issue.id} data-bs-bead-state={state} onClick={() => onOpen(issue)} title={density === 'compact' ? `${issue.id} · ${issue.title}` : undefined}>
      <span className="du-card__title">{isLiveNow && <span className="du-card__live" title="An agent session is working on this now" aria-label="Live session" />}{issue.title}</span>
      {density === 'comfortable' && issue.description && <span className="du-card__summary">{issue.description}</span>}
      <span className="du-card__meta">
        <span>{issue.id}</span>
        {issue.priority <= 1 && <span className="du-card__priority">{PRIORITY_LABEL[issue.priority]}</span>}
        {waiting > 0 && <span>waiting for {waiting}</span>}
        {!nested && parent && density === 'comfortable' && <span className="du-card__epic">{byId.get(parent)?.title}</span>}
      </span>
    </button>
  }
  const entry = (item: BoardEntry, state: BeadState) => {
    if (item.kind === 'card') return card(item.issue, state)
    const expanded = open.has(item.epicId)
    return <div key={`g:${item.epicId}`} className="du-group">
      <button className="du-group__head" aria-expanded={expanded} onClick={() => setOpen(current => toggle(current, item.epicId))}>
        <span aria-hidden>{expanded ? '▾' : '▸'}</span>
        <span className="du-group__title">{item.title}</span>
        <span className="du-group__count" title={`${item.progress.done} of ${item.progress.total} finished`}>{item.children.length} here · {item.progress.done}/{item.progress.total} done</span>
      </button>
      {expanded && <div className="du-group__body">{item.children.map(child => card(child, state, true))}</div>}
    </div>
  }

  return <>
    <div className="du-board__filter">
      <input aria-label="Search requests" className="du-input" type="search" placeholder="Search requests" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="du-seg" role="group" aria-label="Which requests to show">
        <button aria-pressed={lens === 'focus'} onClick={() => setLens('focus')} title="Waiting, live work, urgent items and recent finishes">Focus</button>
        <button aria-pressed={lens === 'all'} onClick={() => setLens('all')}>All</button>
      </div>
      <div className="du-chips" role="group" aria-label="Filters">
        {PRIORITY_CHIPS.map(chip => <button key={chip.value} className="du-chip du-chip--filter" aria-pressed={priorities.has(chip.value)} onClick={() => setPriorities(current => toggle(current, chip.value))}>{chip.label}</button>)}
        <button className="du-chip du-chip--filter" aria-pressed={liveOnly} onClick={() => setLiveOnly(value => !value)} title="Only requests an agent session is working on now">Live session{live.size > 0 ? ` (${live.size})` : ''}</button>
      </div>
      <div className="du-seg du-seg--end" role="group" aria-label="Card density">
        <button aria-pressed={density === 'comfortable'} onClick={() => setDensity('comfortable')}>Comfortable</button>
        <button aria-pressed={density === 'compact'} onClick={() => setDensity('compact')}>Compact</button>
      </div>
    </div>
    {lens === 'focus' && hidden > 0 && <p className="du-board__note">Focus is hiding {hidden} request{hidden === 1 ? '' : 's'} that need no attention yet. <button className="du-link-btn" onClick={() => setLens('all')}>Show all</button></p>}
    <div className="du-board">
      {COLUMNS.map(column => {
        const col = view.get(column.state)!
        return <section key={column.state} className="du-column" aria-label={column.title}>
          <h3><span className={`du-dot du-dot--${column.state}`} />{column.title}<span className="du-column__count" title={col.hiddenByLens ? `${col.hiddenByLens} more hidden by Focus` : undefined}>{col.total}{col.hiddenByLens > 0 ? `+${col.hiddenByLens}` : ''}</span></h3>
          <div className="du-column__list">
            {col.entries.length === 0 && <p className="du-column__empty">{column.empty}</p>}
            {col.entries.map(item => entry(item, column.state))}
            {col.remaining > 0 && <button className="du-btn du-btn--quiet" onClick={() => setLimits(current => ({ ...current, [column.state]: col.entries.length + LIMIT_STEP }))}>Show {Math.min(LIMIT_STEP, col.remaining)} more <span className="du-column__count">({col.remaining} left)</span></button>}
          </div>
        </section>
      })}
    </div>
  </>
}

/** Requests as a designer sees them: what can start, what is moving, what is stuck. */
export function RequestBoard({ onOpen }: { onOpen: (issue: Issue) => void }) {
  const { projects, activeId } = useProjects()
  const active = projects.find(project => project.id === activeId) ?? projects[0] ?? null
  if (!active) return <div className="du-map__hint">No project selected.</div>
  return <BdLiveProvider><BoardInner repoPath={active.path} onOpen={onOpen} /></BdLiveProvider>
}
