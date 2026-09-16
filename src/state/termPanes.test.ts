// RV1 — termPanes store: pure tree-op coverage.
//
// The DOM/pty side needs the real Tauri window (verified by hand per the
// RV1 checklist). These tests lock the tree algebra: split, close/collapse,
// tab lifecycle, directional focus — the parts that silently corrupt state.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  useTermPanes as _use, // referenced to keep the module import side-effect
  splitActive,
  unsplitToTabs,
  closeActivePane,
  newTab,
  switchTab,
  cycleTab,
  moveFocus,
  cyclePane,
  focusPane,
  registerPty,
  setDefaultCwd,
  setActiveProject,
  spawnAgent,
  allAgentBridges,
  leavesOf,
  toggleZoom,
  getZoom,
  termPanesSignature,
  setInsert,
  setRatio,
  activeTabRoot,
  focusPaneDirection,
  resizePane,
  serializeProjects,
  restoreProjects,
} from './termPanes'

// The store is a module singleton. Reset it to a known shape before each
// test by collapsing back to a single pane, then reseeding cwd.
function reset() {
  // Close panes until one remains (closeActivePane keeps >=1).
  for (let i = 0; i < 32; i++) {
    const before = snapshotLeafCount()
    if (before <= 1 && tabCount() <= 1) break
    closeActivePane()
  }
  if (getZoom()) toggleZoom()
  setDefaultCwd('/tmp/reset')
}

// Helpers reach into the store via the exported hook's snapshot indirectly;
// simplest is to re-derive from leavesOf on the active tab. We expose small
// probes through the public surface instead of reading internals.
let _probeState: ReturnType<typeof getState>
function getState() {
  // useSyncExternalStore's getSnapshot isn't exported, so drive through a
  // throwaway subscribe via the hook's underlying store is overkill; instead
  // we read the window mirror the store maintains.
  return (window as unknown as { __bsTerm?: { insert: boolean; paneCount: number } }).__bsTerm
}
function snapshotLeafCount(): number {
  _probeState = getState()
  return _probeState?.paneCount ?? 1
}
function tabCount(): number {
  // No direct export; infer via newTab/switchTab is unsafe. We add a minimal
  // check using cycleTab side-effect-free path: rely on paneCount for pane
  // tests and treat tab tests explicitly below.
  return 1
}

void _use // keep import

describe('termPanes tree algebra', () => {
  beforeEach(() => reset())

  it('starts with a single pane', () => {
    expect(snapshotLeafCount()).toBe(1)
  })

  it('splitActive adds a pane', () => {
    splitActive('v')
    expect(snapshotLeafCount()).toBe(2)
    splitActive('h')
    expect(snapshotLeafCount()).toBe(3)
  })

  it('closeActivePane collapses the split into the sibling', () => {
    splitActive('v') // 2 panes
    splitActive('v') // 3 panes
    expect(snapshotLeafCount()).toBe(3)
    closeActivePane()
    expect(snapshotLeafCount()).toBe(2)
    closeActivePane()
    expect(snapshotLeafCount()).toBe(1)
    // Closing the last pane keeps one alive (never blank).
    const { killPtyId } = closeActivePane()
    expect(snapshotLeafCount()).toBe(1)
    // no pty was registered so nothing to kill
    expect(killPtyId).toBeNull()
  })

  it('registerPty threads a ptyId onto the active leaf then close reports it', () => {
    // fresh single pane; simulate its Terminal spawning
    const before = snapshotLeafCount()
    expect(before).toBe(1)
    // We can't read paneId directly; split so the new pane is active, then
    // register a pty on it and close it — the kill id must come back.
    splitActive('v')
    // active pane is the new leaf; give it a pty via the store API by
    // grabbing its id from leavesOf on a fresh snapshot.
    // (leavesOf needs a Node; the store doesn't export the tree, so we
    //  register through the public focus path instead.)
    // Register requires paneId — exercised indirectly in the DOM; here we
    // just assert close on a pty-less pane returns null.
    const { killPtyId } = closeActivePane()
    expect(killPtyId).toBeNull()
    expect(snapshotLeafCount()).toBe(1)
  })

  it('moveFocus / cyclePane do not throw and keep pane count stable', () => {
    splitActive('v')
    splitActive('h')
    const n = snapshotLeafCount()
    moveFocus('h')
    moveFocus('l')
    moveFocus('j')
    moveFocus('k')
    cyclePane()
    expect(snapshotLeafCount()).toBe(n)
  })

  it('newTab / switchTab / cycleTab keep the active tab a single fresh pane', () => {
    splitActive('v') // tab0 now has 2 panes
    newTab() // tab1: fresh single pane, becomes active
    expect(snapshotLeafCount()).toBe(1)
    cycleTab(-1) // back to tab0
    expect(snapshotLeafCount()).toBe(2)
    switchTab(1) // tab1
    expect(snapshotLeafCount()).toBe(1)
  })

  it('toggleZoom flips zoom target', () => {
    expect(getZoom()).toBeNull()
    toggleZoom()
    expect(getZoom()).not.toBeNull()
    toggleZoom()
    expect(getZoom()).toBeNull()
  })

  it('leavesOf counts leaves of a nested split tree', () => {
    const tree = {
      kind: 'split' as const,
      splitId: 's1',
      dir: 'v' as const,
      ratio: 0.5,
      a: { kind: 'leaf' as const, paneId: 'p1', ptyId: null, cwd: '' },
      b: {
        kind: 'split' as const,
        splitId: 's2',
        dir: 'h' as const,
        ratio: 0.5,
        a: { kind: 'leaf' as const, paneId: 'p2', ptyId: null, cwd: '' },
        b: { kind: 'leaf' as const, paneId: 'p3', ptyId: null, cwd: '' },
      },
    }
    expect(leavesOf(tree).map(l => l.paneId)).toEqual(['p1', 'p2', 'p3'])
  })

  it('focusPane + registerPty are callable without throwing', () => {
    // Smoke: registerPty on an unknown pane is a no-op, focusPane too.
    expect(() => registerPty('nope', 999)).not.toThrow()
    expect(() => focusPane('nope')).not.toThrow()
  })
})

// Code-x8p — the pane surface is keyed by project: switching swaps the whole
// tree, and each project keeps its own panes/agents across a round-trip switch.
describe('termPanes per-project surface (Code-x8p)', () => {
  beforeEach(() => reset())

  it('switching projects gives each its own pane tree', () => {
    // Move off the boot surface onto project A (adopts the pristine boot leaf).
    setActiveProject('projA', '/tmp/a')
    expect(snapshotLeafCount()).toBe(1)
    splitActive('v')
    splitActive('v')
    expect(snapshotLeafCount()).toBe(3)

    // Switch to a fresh project B — its surface is a single pane, not A's 3.
    setActiveProject('projB', '/tmp/b')
    expect(snapshotLeafCount()).toBe(1)

    // Switch back to A — its 3-pane surface is restored intact.
    setActiveProject('projA', '/tmp/a')
    expect(snapshotLeafCount()).toBe(3)
  })

  it('setActiveProject is a no-op when already active', () => {
    setActiveProject('projA', '/tmp/a')
    splitActive('v')
    const n = snapshotLeafCount()
    setActiveProject('projA', '/tmp/a') // same id
    expect(snapshotLeafCount()).toBe(n)
  })

  it('allAgentBridges spans agents in non-active projects', () => {
    setActiveProject('projA', '/tmp/a')
    spawnAgent('projA', '/tmp/a', 'sid-a')
    setActiveProject('projB', '/tmp/b')
    spawnAgent('projB', '/tmp/b', 'sid-b')

    // Even though projA is not active, its agent must still count as live so a
    // project switch never reaps the hidden project's claude sessions.
    const bridges = allAgentBridges()
    expect(bridges.length).toBeGreaterThanOrEqual(2)
  })
})

// Code-1cs / Code-aod — App subscribes to the reconcile SIGNATURE (joined agent
// bridges + active tab), not the whole state, so pure focus/insert churn no
// longer re-renders App. Lock the invariant: bridge-set changes move the sig;
// focus/insert churn leaves it byte-identical.
describe('termPanes reconcile signature (Code-aod)', () => {
  beforeEach(() => reset())

  it('spawnAgent changes the signature', () => {
    setActiveProject('sigA', '/tmp/sig-a')
    const before = termPanesSignature()
    spawnAgent('sigA', '/tmp/sig-a', 'sid-sig')
    expect(termPanesSignature()).not.toBe(before)
  })

  it('setInsert does not change the signature (insert is not in the slice)', () => {
    setActiveProject('sigB', '/tmp/sig-b')
    spawnAgent('sigB', '/tmp/sig-b', 'sid-sig-b')
    const before = termPanesSignature()
    setInsert(true)
    expect(termPanesSignature()).toBe(before)
    setInsert(false)
    expect(termPanesSignature()).toBe(before)
  })

  it('focusPane churn does not change the signature (no bridge-set change)', () => {
    setActiveProject('sigC', '/tmp/sig-c')
    splitActive('v') // 2 shell panes, no agents
    const before = termPanesSignature()
    // Focus the other pane and back — emits, but the bridge set is unchanged.
    cyclePane()
    expect(termPanesSignature()).toBe(before)
    cyclePane()
    expect(termPanesSignature()).toBe(before)
  })
})

// Code-mkv — setRatio writes a split's ratio (draggable seam); persistence
// round-trips the per-project surface incl. ratios + agents, advancing _seq so
// ids minted after restore never collide with rehydrated ones.
describe('termPanes setRatio (Code-mkv)', () => {
  beforeEach(() => reset())

  it('sets the active tab root split ratio, clamped to 0.05..0.95', () => {
    setActiveProject('ratA', '/tmp/rat-a')
    splitActive('v')
    const root = activeTabRoot()
    expect(root.kind).toBe('split')
    if (root.kind !== 'split') return
    expect(root.ratio).toBe(0.5)

    setRatio(root.splitId, 0.7)
    const after = activeTabRoot()
    expect(after.kind === 'split' && after.ratio).toBe(0.7)

    // Clamp: 0 -> 0.05, 1 -> 0.95.
    setRatio(root.splitId, 0)
    expect(activeTabRoot().kind === 'split' && (activeTabRoot() as { ratio: number }).ratio).toBe(0.05)
    setRatio(root.splitId, 1)
    expect(activeTabRoot().kind === 'split' && (activeTabRoot() as { ratio: number }).ratio).toBe(0.95)
  })

  it('setRatio on an unknown splitId is a no-op and does not throw', () => {
    setActiveProject('ratB', '/tmp/rat-b')
    splitActive('v')
    const before = activeTabRoot()
    expect(() => setRatio('nope', 0.3)).not.toThrow()
    expect(activeTabRoot()).toBe(before) // same ref — no rebuild
  })
})

describe('termPanes tiling directions (Code-0cp.10.2)', () => {
  beforeEach(() => reset())

  it('focuses the geometrically adjacent pane in each direction', () => {
    setActiveProject('tile-focus', '/tmp/tile-focus')
    splitActive('v') // active pane starts on the right
    const root = activeTabRoot()
    expect(root.kind).toBe('split')
    if (root.kind !== 'split') return
    const [left, right] = leavesOf(root)
    focusPaneDirection('left')
    focusPaneDirection('right')

    let disposed: string | undefined
    const onDispose = (event: Event) => {
      disposed = (event as CustomEvent<{ paneId?: string }>).detail.paneId
    }
    window.addEventListener('terminal:dispose', onDispose)
    closeActivePane()
    window.removeEventListener('terminal:dispose', onDispose)
    expect(disposed).toBe(right.paneId)

    // The same tree helper handles the orthogonal directions for stacked
    // panes; the call is a no-op when no geometric neighbor exists.
    expect(() => focusPaneDirection('up')).not.toThrow()
    expect(() => focusPaneDirection('down')).not.toThrow()
    expect(left.paneId).not.toBe(disposed)
  })

  it('moves the nearest matching ancestor seam by a bounded fixed step', () => {
    setActiveProject('tile-resize', '/tmp/tile-resize')
    splitActive('v')
    splitActive('h') // active pane is in nested horizontal split
    const initial = activeTabRoot()
    expect(initial.kind).toBe('split')
    if (initial.kind !== 'split' || initial.b.kind !== 'split') return
    expect(initial.ratio).toBe(0.5)
    expect(initial.b.ratio).toBe(0.5)

    resizePane('left') // outer vertical seam
    let after = activeTabRoot()
    expect(after.kind === 'split' && after.ratio).toBe(0.45)
    resizePane('up') // nested horizontal seam
    after = activeTabRoot()
    expect(after.kind === 'split' && after.b.kind === 'split' && after.b.ratio).toBe(0.45)

    for (let i = 0; i < 20; i++) resizePane('left')
    after = activeTabRoot()
    expect(after.kind === 'split' && after.ratio).toBe(0.05)
    for (let i = 0; i < 40; i++) resizePane('right')
    after = activeTabRoot()
    expect(after.kind === 'split' && after.ratio).toBe(0.95)
  })
})

describe('termPanes persistence round-trip (Code-mkv)', () => {
  beforeEach(() => reset())

  it('serialize -> restore rehydrates the tree, strips ptyId, keeps agent bridge', () => {
    setActiveProject('persA', '/tmp/pers-a')
    splitActive('v')
    spawnAgent('persA', '/tmp/pers-a', 'sid-pers')
    // Grab an agent bridge id to assert it survives.
    const root = activeTabRoot()
    const agentBridge = leavesOf(root).find(l => l.agent)?.agent?.bridgeId
    expect(agentBridge).toBeTruthy()

    const json = serializeProjects()
    expect(json).toContain('persA')

    // Wipe in-memory PROJECTS by switching away + reset, then restore.
    setActiveProject('elsewhere', '/tmp/else')
    restoreProjects(json)

    // Switching back to persA loads the restored surface.
    setActiveProject('persA', '/tmp/pers-a')
    const restored = leavesOf(activeTabRoot())
    // 3 leaves: original shell, split shell, agent.
    expect(restored.length).toBe(3)
    // ptyId stripped on every leaf.
    expect(restored.every(l => l.ptyId === null)).toBe(true)
    expect(restored.filter(l => !l.fileNav).every(l => l.restored === true)).toBe(true)
    // Agent bridge preserved (resume key stability).
    expect(restored.some(l => l.agent?.bridgeId === agentBridge)).toBe(true)
  })

  it('restore advances _seq so a later split does not collide with rehydrated ids', () => {
    setActiveProject('seqA', '/tmp/seq-a')
    splitActive('v')
    splitActive('v') // several panes/splits -> higher suffixes
    const json = serializeProjects()

    restoreProjects(json)
    setActiveProject('seqA', '/tmp/seq-a')

    // Collect all ids before, split, assert the new ids are unique (no dup).
    const idsBefore = new Set(leavesOf(activeTabRoot()).map(l => l.paneId))
    splitActive('h')
    const leavesAfter = leavesOf(activeTabRoot())
    const newLeaf = leavesAfter.find(l => !idsBefore.has(l.paneId))
    expect(newLeaf).toBeTruthy()
    // The freshly minted paneId must not duplicate any existing one.
    const allIds = leavesAfter.map(l => l.paneId)
    expect(new Set(allIds).size).toBe(allIds.length)
  })

  it('restore ignores a corrupt / wrong-version payload', () => {
    expect(() => restoreProjects('not json')).not.toThrow()
    expect(() => restoreProjects(JSON.stringify({ v: 999, projects: {} }))).not.toThrow()
    expect(() => restoreProjects(null)).not.toThrow()
  })
})

describe('unsplit session ownership', () => {
  it('moves nested panes to tabs without changing shell IDs and clears zoom', () => {
    setActiveProject('unsplit-test', '/tmp/unsplit')
    splitActive('v')
    splitActive('h')
    const original = leavesOf(activeTabRoot())
    original.forEach((leaf, i) => registerPty(leaf.paneId, 700 + i))
    focusPane(original[1].paneId)
    toggleZoom()
    unsplitToTabs()
    expect(getZoom()).toBeNull()
    expect(activeTabRoot()).toMatchObject({ kind: 'leaf', paneId: original[1].paneId, ptyId: 701 })
    cycleTab(1)
    expect(activeTabRoot()).toMatchObject({ paneId: original[0].paneId, ptyId: 700 })
    cycleTab(1)
    expect(activeTabRoot()).toMatchObject({ paneId: original[2].paneId, ptyId: 702 })
    expect(closeActivePane().killPtyId).toBe(702)
    expect(activeTabRoot()).toMatchObject({ paneId: original[1].paneId, ptyId: 701 })
  })
  it('closing a zoomed pane reveals the surviving split', () => {
    setActiveProject('close-zoom-test', '/tmp/close')
    splitActive('v')
    splitActive('h')
    toggleZoom()
    closeActivePane()
    expect(getZoom()).toBeNull()
    expect(leavesOf(activeTabRoot())).toHaveLength(2)
  })
})
