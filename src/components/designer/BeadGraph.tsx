import { useMemo, useState } from 'react'
import type { Issue } from '../../types/issue'
import { BdLiveProvider } from '../../lib/BdLiveProvider'
import { useBdSnapshot } from '../../lib/bdCache'
import { useProjects } from '../../state/projects'
import { spawnAgent } from '../../state/termPanes'
import { setSkin } from '../../state/skin'

// Bead graph — the Designer UI centerpiece. Nodes are beads; edges are bd
// dependency links from each Issue's `dependencies` array (a blocker edge
// `depends_on_id -> issue_id`: the blocker sits one column left of the bead it
// blocks). Layout is a hand-rolled left-to-right DAG. "Claude walks the graph,
// not a list" — the next-pickable node (a ready bead with no open blockers,
// i.e. what bd_ready returns) is highlighted.

const NODE_W = 190
const NODE_H = 64
const COL_GAP = 72
const ROW_GAP = 24
const PAD = 32

type NodeState = 'ready' | 'in_progress' | 'blocked' | 'closed'

interface Placed {
  issue: Issue
  state: NodeState
  next: boolean
  col: number
  row: number
  x: number
  y: number
}

const STATE_TOKEN: Record<NodeState, string> = {
  ready: 'var(--du-status-ready)',
  in_progress: 'var(--du-status-in_progress)',
  blocked: 'var(--du-status-blocked)',
  closed: 'var(--du-status-closed)',
}

const STATE_LABEL: Record<NodeState, string> = {
  ready: 'Ready',
  in_progress: 'In progress',
  blocked: 'Blocked',
  closed: 'Done',
}

const LEGEND: NodeState[] = ['ready', 'in_progress', 'blocked', 'closed']

function classify(issue: Issue, readyIds: Set<string>): NodeState {
  if (issue.status === 'closed') return 'closed'
  if (issue.status === 'in_progress') return 'in_progress'
  if (issue.status === 'blocked') return 'blocked'
  // Open: ready if bd_ready surfaced it, otherwise it has open blockers.
  return readyIds.has(issue.id) ? 'ready' : 'blocked'
}

// Assign each issue a DAG column = 1 + max(blocker columns) (roots at 0). Rows
// are packed per column so nodes stack without overlap. Blockers come from the
// `dependencies` edges (depends_on_id blocks issue_id); an issue with no
// in-graph blocker is a root. Cycles are broken by the `seen` guard.
function blockersOf(issues: Issue[]): Map<string, string[]> {
  const ids = new Set(issues.map(i => i.id))
  const map = new Map<string, string[]>()
  for (const issue of issues) {
    for (const dep of issue.dependencies ?? []) {
      // Edge: dep.depends_on_id blocks dep.issue_id. Record the blocker on the
      // blocked node, keeping only edges where both ends are in the graph.
      if (dep.issue_id !== issue.id) continue
      if (!ids.has(dep.depends_on_id)) continue
      const arr = map.get(dep.issue_id) ?? []
      arr.push(dep.depends_on_id)
      map.set(dep.issue_id, arr)
    }
  }
  return map
}

function layout(issues: Issue[], readyIds: Set<string>): { nodes: Placed[]; width: number; height: number } {
  const byId = new Map(issues.map(i => [i.id, i]))
  const blockers = blockersOf(issues)
  const colCache = new Map<string, number>()

  const colOf = (id: string, seen: Set<string>): number => {
    const cached = colCache.get(id)
    if (cached !== undefined) return cached
    let col = 0
    for (const blocker of blockers.get(id) ?? []) {
      if (!byId.has(blocker) || seen.has(blocker)) continue
      seen.add(blocker)
      col = Math.max(col, colOf(blocker, seen) + 1)
      seen.delete(blocker)
    }
    colCache.set(id, col)
    return col
  }

  const rowCounters = new Map<number, number>()
  const nodes: Placed[] = issues.map(issue => {
    const col = colOf(issue.id, new Set([issue.id]))
    const row = rowCounters.get(col) ?? 0
    rowCounters.set(col, row + 1)
    return {
      issue,
      state: classify(issue, readyIds),
      next: false,
      col,
      row,
      x: PAD + col * (NODE_W + COL_GAP),
      y: PAD + row * (NODE_H + ROW_GAP),
    }
  })

  // Next-pickable: the first ready node (bd_ready order preserved by input).
  const firstReady = nodes.find(n => n.state === 'ready')
  if (firstReady) firstReady.next = true

  const maxCol = nodes.reduce((m, n) => Math.max(m, n.col), 0)
  const maxRow = Math.max(0, ...Array.from(rowCounters.values()))
  return {
    nodes,
    width: PAD * 2 + (maxCol + 1) * NODE_W + maxCol * COL_GAP,
    height: PAD * 2 + maxRow * NODE_H + Math.max(0, maxRow - 1) * ROW_GAP,
  }
}

function isToday(iso: string | null): boolean {
  if (!iso) return false
  const d = new Date(iso)
  const now = new Date()
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}

function GraphInner({ repoPath, projectId, cwd }: { repoPath: string; projectId: string; cwd: string }) {
  const snap = useBdSnapshot(repoPath)

  const readyIds = useMemo(() => new Set(snap.ready.map(i => i.id)), [snap.ready])
  const { nodes, width, height } = useMemo(
    () => layout(snap.all, readyIds),
    [snap.all, readyIds],
  )

  const nodeById = useMemo(() => new Map(nodes.map(n => [n.issue.id, n])), [nodes])

  // Edges: blocker -> blocked, from each issue's dependency list. Both ends
  // must be placed nodes in the graph.
  const edges = useMemo(
    () =>
      nodes.flatMap(n =>
        (n.issue.dependencies ?? [])
          .filter(d => d.issue_id === n.issue.id && nodeById.has(d.depends_on_id))
          .map(d => ({ from: nodeById.get(d.depends_on_id)!, to: n })),
      ),
    [nodes, nodeById],
  )

  const counts = useMemo(() => {
    let ready = 0
    let inProgress = 0
    let blocked = 0
    let doneToday = 0
    for (const n of nodes) {
      if (n.state === 'ready') ready++
      else if (n.state === 'in_progress') inProgress++
      else if (n.state === 'blocked') blocked++
      else if (n.state === 'closed' && isToday(n.issue.closed_at)) doneToday++
    }
    return { ready, inProgress, blocked, doneToday }
  }, [nodes])

  if (!snap.loaded) return <div style={styles.hint}>Loading graph…</div>
  if (snap.error) return <div style={styles.hint}>bd error: {snap.error}</div>
  if (nodes.length === 0) return <div style={styles.hint}>No beads to graph.</div>

  // RV8.4 — bead-pane duality: clicking a READY node spawns a Claude agent pane
  // targeting that bead (plan posture, matching App's spawn idiom) AND switches to
  // the terminal skin, which is where agent panes render — so the click lands you
  // ON the new pane. The reverse direction (agent closes bead -> graph re-derives)
  // is already live via the bd FSEvents snapshot, closing the loop.
  const onActivate = (issue: Issue) => {
    spawnAgent(projectId, cwd, crypto.randomUUID(), 'plan')
    setSkin('terminal')
    void issue // the pane targets the active project; per-bead prompt pre-fill is deferred (RV8).
  }

  return (
    <div style={styles.wrap}>
      {/* Count strip */}
      <div style={styles.strip}>
        <Stat label="Ready" value={counts.ready} tint="var(--du-status-ready)" />
        <Stat label="In progress" value={counts.inProgress} tint="var(--du-status-in_progress)" />
        <Stat label="Blocked" value={counts.blocked} tint="var(--du-status-blocked)" />
        <Stat label="Done today" value={counts.doneToday} tint="var(--du-status-closed)" />
      </div>

      {/* Scrollable graph canvas */}
      <div style={styles.canvas}>
        <div style={{ position: 'relative', width, height }}>
          <svg width={width} height={height} style={styles.svg}>
            {edges.map(({ from, to }, i) => {
              const x1 = from.x + NODE_W
              const y1 = from.y + NODE_H / 2
              const x2 = to.x
              const y2 = to.y + NODE_H / 2
              const mid = (x1 + x2) / 2
              return (
                <path
                  key={i}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--bs-border)"
                  strokeWidth={1.5}
                />
              )
            })}
          </svg>
          {nodes.map(n => (
            <Node key={n.issue.id} node={n} onActivate={onActivate} />
          ))}
        </div>
      </div>

      {/* Legend */}
      <div style={styles.legend}>
        {LEGEND.map(s => (
          <span key={s} style={styles.legendItem}>
            <span style={{ ...styles.legendDot, background: STATE_TOKEN[s] }} />
            {STATE_LABEL[s]}
          </span>
        ))}
        <span style={styles.legendItem}>
          <span style={{ ...styles.legendDot, ...styles.nextRing }} />
          Next pickable
        </span>
      </div>
    </div>
  )
}

function Node({ node, onActivate }: { node: Placed; onActivate?: (issue: Issue) => void }) {
  const { issue, state, next, x, y } = node
  const [hover, setHover] = useState(false)
  const clickable = state === 'ready' && onActivate != null
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={clickable ? () => onActivate!(issue) : undefined}
      data-bs-bead-node={issue.id}
      data-bs-bead-state={state}
      style={{
        ...styles.node,
        left: x,
        top: y,
        cursor: clickable ? 'pointer' : 'default',
        borderColor: next || hover ? 'var(--bs-orange)' : 'var(--bs-border)',
        boxShadow: next
          ? '0 0 0 2px color-mix(in srgb, var(--bs-orange) 35%, transparent)'
          : hover
            ? '0 4px 14px color-mix(in srgb, var(--bs-orange) 22%, transparent)'
            : 'var(--bs-shadow-card)',
        transform: hover ? 'translateY(-2px)' : 'translateY(0)',
        // DU4 motion polish — lift + accent on hover; keeps the NEXT ring.
        transition: 'transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease',
      }}
      title={clickable ? `${issue.title} — click to spawn an agent` : issue.title}
    >
      <div style={styles.nodeHead}>
        <span style={{ ...styles.statusDot, background: STATE_TOKEN[state] }} />
        <span style={styles.nodeId}>{issue.id}</span>
        {next && <span style={styles.nextTag}>NEXT</span>}
      </div>
      <div style={styles.nodeTitle}>{issue.title}</div>
    </div>
  )
}

function Stat({ label, value, tint }: { label: string; value: number; tint: string }) {
  return (
    <div style={styles.stat}>
      <span style={{ ...styles.statDot, background: tint }} />
      <span style={styles.statValue}>{value}</span>
      <span style={styles.statLabel}>{label}</span>
    </div>
  )
}

/**
 * Entry point mounted into DesignerShell's graph slot. It supplies its own
 * BdLiveProvider (the designer shell renders outside App's provider) and
 * resolves the active project's repoPath the same way App does.
 */
export function BeadGraph() {
  const { projects, activeId } = useProjects()
  const active = projects.find(p => p.id === activeId) ?? projects[0] ?? null

  if (!active) return <div style={styles.hint}>No project selected.</div>

  return (
    <BdLiveProvider>
      <GraphInner repoPath={active.path} projectId={active.id} cwd={active.path} />
    </BdLiveProvider>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  },
  strip: {
    display: 'flex',
    gap: 20,
    padding: '16px 24px',
    borderBottom: '1px solid var(--bs-border)',
    flexShrink: 0,
  },
  stat: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
  },
  statDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    alignSelf: 'center',
  },
  statValue: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--bs-fg)',
  },
  statLabel: {
    fontSize: 12,
    color: 'var(--bs-fg-muted)',
  },
  canvas: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    background: 'var(--bs-bg-dark)',
  },
  svg: {
    position: 'absolute',
    top: 0,
    left: 0,
    pointerEvents: 'none',
  },
  node: {
    position: 'absolute',
    width: NODE_W,
    height: NODE_H,
    padding: '8px 10px',
    background: 'var(--bs-bg-float)',
    border: '1px solid var(--bs-border)',
    borderRadius: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    overflow: 'hidden',
  },
  nodeHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  nodeId: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--bs-fg-muted)',
    fontFamily: 'var(--du-font-mono)',
  },
  nextTag: {
    marginLeft: 'auto',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: 'var(--bs-orange)',
  },
  nodeTitle: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--bs-fg)',
    lineHeight: 1.3,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  legend: {
    display: 'flex',
    gap: 18,
    padding: '10px 24px',
    borderTop: '1px solid var(--bs-border)',
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: 'var(--bs-fg-muted)',
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    flexShrink: 0,
  },
  nextRing: {
    background: 'transparent',
    border: '2px solid var(--bs-orange)',
  },
  hint: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--bs-fg-muted)',
    fontSize: 13,
  },
}
