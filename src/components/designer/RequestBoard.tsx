import { useMemo, useState } from 'react'
import { BdLiveProvider } from '../../lib/BdLiveProvider'
import { useBdSnapshot } from '../../lib/bdCache'
import { useProjects } from '../../state/projects'
import type { Issue } from '../../types/issue'
import { beadRelations, classifyBead, type BeadState } from './beadMap'
import { PRIORITY_LABEL } from './beadPresentation'

const COLUMNS: { state: BeadState; title: string; empty: string }[] = [
  { state: 'ready', title: 'Ready to start', empty: 'Nothing is waiting to start.' },
  { state: 'in_progress', title: 'In progress', empty: 'Nothing is being worked on.' },
  { state: 'blocked', title: 'Waiting on something', empty: 'Nothing is stuck.' },
  { state: 'closed', title: 'Done', empty: 'Finished requests appear here.' },
]
const PAGE = 40

function closedRecently(a: Issue, b: Issue): number {
  return (b.closed_at ?? b.updated_at).localeCompare(a.closed_at ?? a.updated_at)
}

function BoardInner({ repoPath, onOpen }: { repoPath: string; onOpen: (issue: Issue) => void }) {
  const snap = useBdSnapshot(repoPath)
  const [query, setQuery] = useState('')
  const [limits, setLimits] = useState<Partial<Record<BeadState, number>>>({})
  const readyIds = useMemo(() => new Set(snap.ready.map(issue => issue.id)), [snap.ready])
  const relations = useMemo(() => beadRelations(snap.all), [snap.all])
  const byId = useMemo(() => new Map(snap.all.map(issue => [issue.id, issue])), [snap.all])
  const columns = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const groups = new Map<BeadState, Issue[]>(COLUMNS.map(column => [column.state, []]))
    for (const issue of snap.all) {
      // An epic with tickets under it is a heading on the map, not a request.
      if ((relations.get(issue.id)?.children.length ?? 0) > 0) continue
      if (needle && !issue.title.toLowerCase().includes(needle) && !issue.id.toLowerCase().includes(needle)) continue
      groups.get(classifyBead(issue, readyIds))!.push(issue)
    }
    for (const [state, list] of groups) list.sort(state === 'closed' ? closedRecently : (a, b) => a.priority - b.priority)
    return groups
  }, [snap.all, relations, readyIds, query])

  if (!snap.loaded) return <div className="du-map__hint">Loading requests…</div>
  if (snap.error) return <div className="du-map__hint">bd error: {snap.error}</div>
  return <>
    <div className="du-board__filter"><input aria-label="Search requests" className="du-input" type="search" placeholder="Search requests" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="du-board">
      {COLUMNS.map(column => {
        const items = columns.get(column.state) ?? []
        const limit = limits[column.state] ?? PAGE
        return <section key={column.state} className="du-column" aria-label={column.title}>
          <h3><span className={`du-dot du-dot--${column.state}`} />{column.title}<span className="du-column__count">{items.length}</span></h3>
          <div className="du-column__list">
            {items.length === 0 && <p className="du-column__empty">{column.empty}</p>}
            {items.slice(0, limit).map(issue => {
              const parent = relations.get(issue.id)?.parent
              const waiting = relations.get(issue.id)?.blockedBy.filter(id => byId.get(id)?.status !== 'closed').length ?? 0
              return <button key={issue.id} className={`du-card du-card--${column.state}`} data-bs-bead-node={issue.id} data-bs-bead-state={column.state} onClick={() => onOpen(issue)}>
                <span className="du-card__title">{issue.title}</span>
                {issue.description && <span className="du-card__summary">{issue.description}</span>}
                <span className="du-card__meta">
                  <span>{issue.id}</span>
                  {issue.priority <= 1 && <span className="du-card__priority">{PRIORITY_LABEL[issue.priority]}</span>}
                  {waiting > 0 && <span>waiting for {waiting}</span>}
                  {parent && <span className="du-card__epic">{byId.get(parent)?.title}</span>}
                </span>
              </button>
            })}
            {items.length > limit && <button className="du-btn du-btn--quiet" onClick={() => setLimits(current => ({ ...current, [column.state]: limit + PAGE }))}>Show {Math.min(PAGE, items.length - limit)} more</button>}
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
