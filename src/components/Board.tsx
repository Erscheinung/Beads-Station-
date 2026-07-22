import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type { Issue } from '../types/issue'
import {
  bdReady,
  bdList,
  bdClaim,
  bdSetStatus,
  bdCloseIssue,
} from '../types/issue'
import { Card } from './Card'
import { Column } from './Column'
import { useBdLiveContext } from '../lib/BdLiveProvider'

interface BoardProps {
  repoPath: string
  projectId: string
}

type ColumnId = 'ready' | 'in_progress' | 'blocked' | 'done'

const COLUMNS: { id: ColumnId; title: string }[] = [
  { id: 'ready', title: 'Ready' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'blocked', title: 'Blocked' },
  { id: 'done', title: 'Done' },
]

interface BoardState {
  ready: Issue[]
  in_progress: Issue[]
  blocked: Issue[]
  done: Issue[]
}

const EMPTY_STATE: BoardState = {
  ready: [],
  in_progress: [],
  blocked: [],
  done: [],
}

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

let toastCounter = 0

/**
 * 4-column Jira-style board. Reads ready/list issues, partitions by status,
 * and drives optimistic drag-drop transitions through the bd mutation
 * commands. On bd error the previous state is restored and a toast is shown.
 *
 * Project filtering: if any issue carries a `project=<projectId>` label, we
 * filter to those; otherwise we display every issue in the repo. Phase 8
 * will tighten this once labels are reliably present.
 */
export function Board({ repoPath, projectId }: BoardProps) {
  const [state, setState] = useState<BoardState>(EMPTY_STATE)
  const [error, setError] = useState<string | null>(null)
  const [activeIssue, setActiveIssue] = useState<Issue | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  // Bumped after every successful mutation to force a refetch.
  const [version, setVersion] = useState(0)
  const dragGenRef = useRef(0)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  )

  const pushToast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastCounter
    setToasts(t => [...t, { id, text, kind }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500)
  }, [])

  const refetch = useCallback(async () => {
    try {
      dragGenRef.current++
      const [ready, all] = await Promise.all([bdReady(repoPath), bdList(repoPath, null)])

      // Project filter: prefer label-based when present anywhere in the repo.
      const projectLabel = `project=${projectId}`
      const anyLabeled = all.some(i => (i.labels ?? []).includes(projectLabel))
      const filterIssue = (i: Issue) =>
        !anyLabeled || (i.labels ?? []).includes(projectLabel)

      const filteredReady = ready.filter(filterIssue)
      const filteredAll = all.filter(filterIssue)

      const readyIds = new Set(filteredReady.map(i => i.id))

      const next: BoardState = { ready: filteredReady, in_progress: [], blocked: [], done: [] }
      for (const i of filteredAll) {
        if (i.status === 'in_progress') next.in_progress.push(i)
        else if (i.status === 'blocked') next.blocked.push(i)
        else if (i.status === 'closed') next.done.push(i)
        else if (i.status === 'open' && !readyIds.has(i.id)) {
          // Open but excluded from ready (likely has open blockers).
          next.blocked.push(i)
        }
      }
      setState(next)
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [repoPath, projectId])

  useEffect(() => {
    refetch()
  }, [refetch, version])

  useBdLiveContext(repoPath, refetch)

  const findIssue = useCallback(
    (id: string): { issue: Issue; column: ColumnId } | null => {
      for (const col of COLUMNS) {
        const found = state[col.id].find(i => i.id === id)
        if (found) return { issue: found, column: col.id }
      }
      return null
    },
    [state],
  )

  const handleDragStart = useCallback(
    (e: DragStartEvent) => {
      const found = findIssue(String(e.active.id))
      setActiveIssue(found?.issue ?? null)
    },
    [findIssue],
  )

  const moveIssueLocally = useCallback(
    (prev: BoardState, id: string, from: ColumnId, to: ColumnId): BoardState => {
      const issue = prev[from].find(i => i.id === id)
      if (!issue) return prev
      return {
        ...prev,
        [from]: prev[from].filter(i => i.id !== id),
        [to]: [issue, ...prev[to]],
      }
    },
    [],
  )

  const handleDragEnd = useCallback(
    async (e: DragEndEvent) => {
      setActiveIssue(null)
      const overId = e.over?.id
      if (!overId) return
      const targetCol = String(overId) as ColumnId
      if (!COLUMNS.some(c => c.id === targetCol)) return

      const id = String(e.active.id)
      const found = findIssue(id)
      if (!found || found.column === targetCol) return

      const fromCol = found.column
      const gen = dragGenRef.current
      // Snapshot for rollback.
      const snapshot = state
      // Optimistic update.
      setState(prev => moveIssueLocally(prev, id, fromCol, targetCol))

      const mutate = async () => {
        if (targetCol === 'in_progress' && fromCol === 'ready') {
          await bdClaim(repoPath, id)
        } else if (targetCol === 'in_progress') {
          await bdSetStatus(repoPath, id, 'in_progress')
        } else if (targetCol === 'blocked') {
          await bdSetStatus(repoPath, id, 'blocked')
        } else if (targetCol === 'done') {
          await bdCloseIssue(repoPath, id, 'Closed via Beads Station drag')
        } else if (targetCol === 'ready') {
          await bdSetStatus(repoPath, id, 'open')
        }
      }

      try {
        await mutate()
        setVersion(v => v + 1)
      } catch (err) {
        if (dragGenRef.current === gen) {
          setState(snapshot)
        }
        pushToast(`bd error: ${err}`, 'error')
      }
    },
    [findIssue, moveIssueLocally, pushToast, repoPath, state],
  )

  const totalCount = useMemo(
    () => state.ready.length + state.in_progress.length + state.blocked.length + state.done.length,
    [state],
  )

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--bs-bg)',
        position: 'relative',
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--bs-border)',
          fontSize: 11,
          opacity: 0.7,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span>BOARD · {projectId}</span>
        <span style={{ opacity: 0.5 }}>· {totalCount} issues</span>
        {error && (
          <span style={{ marginLeft: 'auto', color: 'var(--bs-red)' }}>{error}</span>
        )}
      </div>
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveIssue(null)}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: 8,
            padding: 8,
          }}
        >
          {COLUMNS.map(col => (
            <Column key={col.id} id={col.id} title={col.title} count={state[col.id].length}>
              {state[col.id].map(issue => (
                <Card key={issue.id} issue={issue} />
              ))}
            </Column>
          ))}
        </div>
        <DragOverlay>
          {activeIssue ? <Card issue={activeIssue} /> : null}
        </DragOverlay>
      </DndContext>
      {toasts.length > 0 && (
        <div
          style={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            pointerEvents: 'none',
          }}
        >
          {toasts.map(t => (
            <div
              key={t.id}
              style={{
                padding: '8px 12px',
                fontSize: 12,
                background: t.kind === 'error' ? 'var(--bs-red)' : 'var(--bs-bg-elev)',
                color: t.kind === 'error' ? 'var(--bs-bg-dark)' : 'var(--bs-fg)',
                border: '1px solid var(--bs-border)',
                borderRadius: 4,
                boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
                maxWidth: 360,
              }}
            >
              {t.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
