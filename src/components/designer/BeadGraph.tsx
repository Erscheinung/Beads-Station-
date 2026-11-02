import { useEffect, useMemo, useRef, useState } from 'react'
import type { Issue } from '../../types/issue'
import { BdLiveProvider } from '../../lib/BdLiveProvider'
import { useBdSnapshot } from '../../lib/bdCache'
import { useProjects } from '../../state/projects'
import { beadCounts, beadRelations, chain, layoutBeadMap, NODE_WIDTH, type BeadState, type MapNode } from './beadMap'
import { BeadInspector } from './BeadInspector'
import { STATE_LABEL, StatePill } from './beadPresentation'

// The bead map. Lanes are epics, arrows are blockers, and a selected bead lights
// up what it waits for and what it holds up. One click inspects; a double click
// or Return opens the bead. DesignerShell owns what happens after opening.

const FILTERS: BeadState[] = ['ready', 'in_progress', 'blocked']

function MapInner({ repoPath, onOpen, onOpenSession }: { repoPath: string; onOpen: (issue: Issue) => void; onOpenSession?: (issue: Issue) => void }) {
  const snap = useBdSnapshot(repoPath)
  const [query, setQuery] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [states, setStates] = useState<ReadonlySet<BeadState>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const canvas = useRef<HTMLDivElement>(null)

  const readyIds = useMemo(() => new Set(snap.ready.map(issue => issue.id)), [snap.ready])
  const relations = useMemo(() => beadRelations(snap.all), [snap.all])
  const counts = useMemo(() => beadCounts(snap.all, readyIds), [snap.all, readyIds])
  const map = useMemo(() => layoutBeadMap(snap.all, readyIds, { query, showDone, states }), [snap.all, readyIds, query, showDone, states])
  const nodeById = useMemo(() => new Map(map.nodes.map(node => [node.issue.id, node])), [map.nodes])
  const selected = selectedId ? snap.all.find(issue => issue.id === selectedId) ?? null : null

  const focusId = hoveredId ?? selectedId
  const focus = useMemo(() => {
    if (!focusId || !relations.has(focusId)) return null
    return { upstream: chain(focusId, relations, 'blockedBy'), downstream: chain(focusId, relations, 'blocks') }
  }, [focusId, relations])

  // Picking a bead from the inspector can land it off screen.
  useEffect(() => {
    if (!selectedId) return
    canvas.current?.querySelector(`[data-bs-bead-node="${CSS.escape(selectedId)}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  if (!snap.loaded) return <div className="du-map__hint">Loading beads…</div>
  if (snap.error) return <div className="du-map__hint">bd error: {snap.error}</div>
  if (snap.all.length === 0) return <div className="du-map__hint">No beads yet. Capture a request to start the map.</div>

  const toggleState = (state: BeadState) => setStates(current => {
    const next = new Set(current)
    if (!next.delete(state)) next.add(state)
    return next
  })

  const edgeClass = (from: string, to: string) => {
    if (!focus || !focusId) return ''
    if ((focus.upstream.has(from) || from === focusId) && (focus.upstream.has(to) || to === focusId)) return ' is-upstream'
    if ((focus.downstream.has(to) || to === focusId) && (focus.downstream.has(from) || from === focusId)) return ' is-downstream'
    return ' is-dim'
  }

  return (
    <div className="du-map">
      <div className="du-map__toolbar">
        <input aria-label="Search beads" className="du-input" type="search" placeholder="Search beads" value={query} onChange={event => setQuery(event.target.value)} />
        {FILTERS.map(state => (
          <button key={state} className={`du-chip${states.has(state) ? ' is-on' : ''}`} aria-pressed={states.has(state)} onClick={() => toggleState(state)}>
            <span className={`du-dot du-dot--${state}`} />{STATE_LABEL[state]} <strong>{counts[state]}</strong>
          </button>
        ))}
        <button className={`du-chip${showDone ? ' is-on' : ''}`} aria-pressed={showDone} onClick={() => setShowDone(value => !value)}>
          <span className="du-dot du-dot--closed" />Done <strong>{counts.closed}</strong>
        </button>
      </div>
      <div className={`du-map__body${selected ? ' has-inspector' : ''}`}>
        <div className="du-map__canvas" ref={canvas} onClick={event => { if (event.target === event.currentTarget) setSelectedId(null) }}>
          {map.nodes.length === 0
            ? <div className="du-map__hint">Nothing matches. {showDone ? '' : 'Finished beads are hidden; turn on Done to include them.'}</div>
            : <div className="du-map__surface" style={{ width: map.width, height: map.height }}>
                {map.lanes.map(lane => (
                  <section key={lane.id} className="du-lane" style={{ top: lane.y, height: lane.height, width: map.width - 24 }} aria-label={lane.title}>
                    <button className="du-lane__head" disabled={!lane.epic} onClick={() => lane.epic && setSelectedId(lane.epic.id)} onDoubleClick={() => lane.epic && onOpen(lane.epic)}>
                      <span className="du-lane__title">{lane.title}</span>
                      {lane.epic && <span className="du-lane__id">{lane.epic.id}</span>}
                      <span className="du-progress" aria-label={`${lane.done} of ${lane.total} done`}><span style={{ width: `${lane.total ? (lane.done / lane.total) * 100 : 0}%` }} /></span>
                      <span className="du-lane__count">{lane.done}/{lane.total}</span>
                    </button>
                  </section>
                ))}
                <svg className="du-map__edges" width={map.width} height={map.height} aria-hidden>
                  <defs>
                    {['rest', 'upstream', 'downstream'].map(kind => (
                      <marker key={kind} id={`du-arrow-${kind}`} className={`du-arrow du-arrow--${kind}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                        <path d="M0,0 L8,4 L0,8 z" />
                      </marker>
                    ))}
                  </defs>
                  {map.edges.map(edge => {
                    const from = nodeById.get(edge.from)!
                    const to = nodeById.get(edge.to)!
                    const x1 = from.x + NODE_WIDTH
                    const y1 = from.y + from.height / 2
                    const x2 = to.x - 2
                    const y2 = to.y + to.height / 2
                    const bend = Math.max(28, Math.abs(x2 - x1) / 2)
                    const kind = edgeClass(edge.from, edge.to)
                    const marker = kind.includes('upstream') ? 'upstream' : kind.includes('downstream') ? 'downstream' : 'rest'
                    return <path key={`${edge.from}-${edge.to}`} className={`du-edge${kind}`} markerEnd={`url(#du-arrow-${marker})`} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} />
                  })}
                </svg>
                {map.nodes.map(node => (
                  <BeadCard
                    key={node.issue.id}
                    node={node}
                    selected={node.issue.id === selectedId}
                    role={!focus || !focusId ? null : node.issue.id === focusId ? 'self' : focus.upstream.has(node.issue.id) ? 'upstream' : focus.downstream.has(node.issue.id) ? 'downstream' : 'other'}
                    onSelect={() => setSelectedId(node.issue.id)}
                    onOpen={() => onOpen(node.issue)}
                    onHover={hover => setHoveredId(hover ? node.issue.id : null)}
                  />
                ))}
              </div>}
        </div>
        <BeadInspector repoPath={repoPath} issue={selected} issues={snap.all} relations={relations} readyIds={readyIds} onSelect={setSelectedId} onOpen={onOpen} onOpenSession={onOpenSession} onClose={() => setSelectedId(null)} />
      </div>
      <p className="du-map__legend">
        <span>Lanes are epics.</span>
        <span><i className="du-key du-key--rest" /> must finish first</span>
        <span><i className="du-key du-key--upstream" /> what this bead waits for</span>
        <span><i className="du-key du-key--downstream" /> what it holds up</span>
        <span>Click to inspect, double-click to open.</span>
      </p>
    </div>
  )
}

function BeadCard({ node, selected, role, onSelect, onOpen, onHover }: {
  node: MapNode
  selected: boolean
  role: 'self' | 'upstream' | 'downstream' | 'other' | null
  onSelect: () => void
  onOpen: () => void
  onHover: (hover: boolean) => void
}) {
  const { issue, state, next, x, y, height } = node
  return (
    <button
      className={`du-bead du-bead--${state}${selected ? ' is-selected' : ''}${role ? ` is-${role}` : ''}`}
      data-bs-bead-node={issue.id}
      data-bs-bead-state={state}
      style={{ left: x, top: y, width: NODE_WIDTH, height }}
      title={`${issue.title}\nDouble-click to open`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onOpen() } }}
    >
      <span className="du-bead__head">
        <span className={`du-dot du-dot--${state}`} />
        <span className="du-bead__id">{issue.id}</span>
        {next ? <span className="du-bead__next">NEXT</span> : <StatePill state={state} quiet />}
      </span>
      <span className="du-bead__title">{issue.title}</span>
    </button>
  )
}

/**
 * Mounted into DesignerShell. It supplies its own BdLiveProvider (the designer
 * shell renders outside App's) and uses the active project as App does.
 */
export function BeadGraph({ onSelect = () => {}, onOpenSession }: { onSelect?: (issue: Issue) => void; onOpenSession?: (issue: Issue) => void }) {
  const { projects, activeId } = useProjects()
  const active = projects.find(project => project.id === activeId) ?? projects[0] ?? null
  if (!active) return <div className="du-map__hint">No project selected.</div>
  return (
    <BdLiveProvider>
      <MapInner repoPath={active.path} onOpen={onSelect} onOpenSession={onOpenSession} />
    </BdLiveProvider>
  )
}
