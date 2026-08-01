import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { DragEndEvent } from '@dnd-kit/core'
import type { ReactNode } from 'react'

// ---------------------------------------------------------------------------
// R3 drag generation-counter regression test.
//
// The bug: Board's drag rollback snapshotted state at drag-start and, on a
// rejected bd mutation, unconditionally restored it — clobbering any newer
// state that a concurrent bd_changed refetch published mid-drag. The fix is a
// generation counter (dragGenRef): refetch bumps it; rollback only restores if
// the gen is unchanged. This test proves the guard: a refetch that lands
// between drag-start and mutation-reject must survive.
//
// We mock the three seams (tauri invoke, BdLiveProvider, DndContext) so the
// scenario is driven deterministically with no dnd-kit pointer physics and no
// fake timers (fake timers + RTL waitFor deadlock).
// ---------------------------------------------------------------------------

interface FakeIssue {
  id: string
  title: string
  status: string
  priority: number
  issue_type: string
  labels: string[] | null
}

const base = (over: Partial<FakeIssue>): FakeIssue => ({
  id: 'x',
  title: 't',
  status: 'open',
  priority: 3,
  issue_type: 'task',
  labels: null,
  ...over,
})

// When true, the list fixture reflects the post-refetch world (newer data).
let refetchedWorld = false
let rejectMutation = false

function readyFixture(): FakeIssue[] {
  return [base({ id: 'ISSUE-1', title: 'DRAG ME' })]
}

function listFixture(): FakeIssue[] {
  if (refetchedWorld) {
    return [
      base({ id: 'ISSUE-1', title: 'DRAG ME' }),
      base({ id: 'ISSUE-NEW', title: 'FROM REFETCH' }),
    ]
  }
  return [base({ id: 'ISSUE-1', title: 'DRAG ME' })]
}

const invokeMock = vi.fn(async (cmd: string) => {
  switch (cmd) {
    case 'bd_ready':
      return readyFixture()
    case 'bd_list':
      return listFixture()
    case 'bd_snapshot':
      // RV3.3 — Board now reads through the shared bd snapshot cache, which
      // calls the single bd_snapshot command. Return the same fixtures the old
      // bd_ready/bd_list pair did so the gen-guard scenario is unchanged.
      return { ready: readyFixture(), all: listFixture() }
    case 'watcher_start':
      return undefined
    case 'bd_claim':
    case 'bd_set_status':
    case 'bd_close':
      if (rejectMutation) {
        // Delay the rejection so the concurrent bd_changed refetch fully
        // settles (gen bump + newer setState published) BEFORE rollback runs.
        // This is what isolates the generation guard: without it, the catch's
        // setState(snapshot) lands after the refetch and clobbers ISSUE-NEW.
        await new Promise(r => setTimeout(r, 20))
        throw new Error('bd mutate failed')
      }
      return undefined
    default:
      return undefined
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [string])),
}))

// safeInvoke also dynamic-imports @tauri-apps/api/core, so the mock above
// covers the issue.ts helpers. Stub the toast side so a rejected mutation's
// toast push is a harmless no-op in the test env.
vi.mock('../lib/invokeErrorBoundary', async () => {
  const invokeCore = async <T,>(cmd: string): Promise<T> => {
    return invokeMock(cmd) as unknown as T
  }
  return {
    safeInvoke: async <T,>(
      cmd: string,
      _args?: Record<string, unknown>,
      opts?: { rethrow?: boolean },
    ): Promise<T | undefined> => {
      try {
        return await invokeCore<T>(cmd)
      } catch (err) {
        if (opts?.rethrow) throw err
        return undefined
      }
    },
    pushInvokeToast: () => 0,
  }
})

// Capture the onChange the Board registers so the test can fire a mid-flight
// refetch. Passthrough BdLiveProvider so no real OS listener is armed.
let capturedOnChange: (() => void) | null = null

vi.mock('../lib/BdLiveProvider', () => ({
  BdLiveProvider: ({ children }: { children: ReactNode }) => children,
  useBdLiveContext: (_repoPath: string, onChange: () => void) => {
    capturedOnChange = onChange
  },
}))

// Replace DndContext with a shim that captures onDragEnd, so we can fire a
// synthetic drag without dnd-kit pointer choreography.
let capturedOnDragEnd: ((e: DragEndEvent) => void | Promise<void>) | null = null

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    DndContext: (props: {
      onDragEnd?: (e: DragEndEvent) => void | Promise<void>
      children?: ReactNode
    }) => {
      capturedOnDragEnd = props.onDragEnd ?? null
      return props.children
    },
    useDraggable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      isDragging: false,
    }),
    DragOverlay: ({ children }: { children?: ReactNode }) => children ?? null,
  }
})

import { Board } from './Board'
import { __resetBdCacheForTest } from '../lib/bdCache'

const dragEnd = (activeId: string, overId: string): DragEndEvent =>
  ({
    active: { id: activeId },
    over: { id: overId },
  }) as unknown as DragEndEvent

describe('Board drag rollback generation guard', () => {
  beforeEach(() => {
    refetchedWorld = false
    rejectMutation = false
    capturedOnChange = null
    capturedOnDragEnd = null
    invokeMock.mockClear()
    __resetBdCacheForTest()
  })

  it('preserves refetched data over the pre-drag snapshot on rejected mutation', async () => {
    render(<Board repoPath="/x" projectId="p" />)

    // Initial refetch resolves and paints the dragged issue.
    await screen.findByText('DRAG ME')
    expect(capturedOnDragEnd).toBeTypeOf('function')
    expect(capturedOnChange).toBeTypeOf('function')

    // Arm the mutation to reject, then start the drag (ready -> in_progress).
    rejectMutation = true

    // Kick off the drag handler. mutate() will reject after ~20ms.
    const dragDone = Promise.resolve(
      capturedOnDragEnd!(dragEnd('ISSUE-1', 'in_progress')),
    )

    // BEFORE the mutation rejects: a bd_changed lands. Flip to the newer world
    // and fire the captured refetch — bumps dragGenRef and publishes NEW state.
    refetchedWorld = true
    await act(async () => {
      capturedOnChange!()
      // Let the refetch's invoke microtasks settle + repaint.
      await Promise.resolve()
      await Promise.resolve()
    })

    // Refetch has painted the newer world before the mutation rejects.
    await screen.findByText('FROM REFETCH')

    // Now let the delayed mutation rejection + rollback catch run.
    await act(async () => {
      await dragDone
      await new Promise(r => setTimeout(r, 40))
    })

    // The rejected mutation must NOT clobber the refetched world: the newer
    // issue stays because dragGenRef advanced past the snapshot's captured gen.
    expect(screen.getByText('FROM REFETCH')).toBeInTheDocument()
  })
})
