// Beads Station — RV1: multiplexed terminal panes (cmux parity).
//
// A tiny external store (mirror the vim.ts useSyncExternalStore pattern —
// no zustand). Model: TABS, each tab a binary SPLIT TREE of shell leaves.
// That's cmux's mental model and the simplest to reason about.
//
//   Leaf = { paneId, ptyId, cwd }            — one shell
//   Split = { split:'h'|'v', a, b }          — two child nodes
//   Tab  = { id, root:Node, activePaneId }    — one tab = one split tree
//   Store = { tabs, activeTabId }
//
// PTY LIFECYCLE IS LIFTED HERE (the whole point of persistence): the store
// owns { paneId -> ptyId }. A <Terminal> leaf is keyed by paneId (NOT the
// active project id), so a split/tab reflow re-parents the same DOM subtree
// instead of unmounting — the shell survives. The store only kills a pty in
// closePane().
//
// getSnapshot MUST be cached (return a stable ref, rebuild only on mutation).
// The R3.5 render-loop was an uncached getSnapshot; do not repeat it.

import { useSyncExternalStore } from 'react'

export type SplitDir = 'h' | 'v'

export interface Leaf {
  kind: 'leaf'
  paneId: string
  ptyId: number | null
  cwd: string
  /**
   * RV2 — additive agent-pane payload. Absent/undefined => legacy shell leaf.
   * Present => this leaf hosts a Claude agent session (ClaudeChat) instead of
   * an xterm shell. Kept as an OPTIONAL field on the same `kind:'leaf'` so all
   * tree helpers (leavesOf/findLeaf/mapLeaf/removeLeaf/layout/moveFocus/
   * cyclePane) stay untouched — they only match on `kind`. Shell leaves have
   * ptyId; agent leaves keep ptyId:null and carry a bridgeId instead.
   */
  agent?: {
    /** pane-scoped identity == claude event namespace + all FE state keys. */
    bridgeId: string
    /** the bd project this agent targets (for label + project RPCs). */
    projectId: string
    /** claude --session-id (uuid). */
    sessionId: string
    permissionMode?: 'acceptEdits' | 'default' | 'plan'
  }
}

/** Named guard for call-site readability (G5). */
export function isAgentLeaf(l: Leaf): boolean {
  return l.agent != null
}

export interface Split {
  kind: 'split'
  dir: SplitDir
  /** ratio of `a` (0..1); b takes the rest. */
  ratio: number
  a: Node
  b: Node
}

export type Node = Leaf | Split

export interface Tab {
  id: string
  root: Node
  activePaneId: string
}

export interface TermPanesState {
  tabs: Tab[]
  activeTabId: string
  /** true == focused pane accepts typing (xterm owns keys); false == pane-op mode. */
  insert: boolean
}

let _seq = 0
function uid(prefix: string): string {
  _seq += 1
  return `${prefix}${_seq}`
}

function newLeaf(cwd: string): Leaf {
  return { kind: 'leaf', paneId: uid('pane'), ptyId: null, cwd }
}

/**
 * RV2 — construct an agent leaf. bridgeId uses the same monotonic seq as
 * paneId/tabId (`agent1`, `agent2`, …) so it's collision-free AND distinct
 * from any projectId, guaranteeing two panes on the SAME project get separate
 * event namespaces. cwd is the PICKED PROJECT path (caller passes it), NOT the
 * active shell's cwd (G3).
 */
function newAgentLeaf(
  cwd: string,
  projectId: string,
  sessionId: string,
  permissionMode?: 'acceptEdits' | 'default' | 'plan',
): Leaf {
  return {
    kind: 'leaf',
    paneId: uid('pane'),
    ptyId: null,
    cwd,
    agent: { bridgeId: uid('agent'), projectId, sessionId, permissionMode },
  }
}

// ---- initial state: one tab, one leaf, no pty yet ----------------------

function makeInitialTab(cwd: string): Tab {
  const leaf = newLeaf(cwd)
  return { id: uid('tab'), root: leaf, activePaneId: leaf.paneId }
}

let state: TermPanesState = (() => {
  const tab = makeInitialTab('')
  return { tabs: [tab], activeTabId: tab.id, insert: false }
})()

const listeners = new Set<() => void>()

function emit(): void {
  // Mirror the pane-op-relevant bits onto window for the non-reactive
  // keymap reader in useVimNav (avoids a stale closure / extra subscribe).
  try {
    const tab = state.tabs.find(t => t.id === state.activeTabId) ?? state.tabs[0]
    const activeLeaf = tab ? findLeaf(tab.root, tab.activePaneId) : null
    ;(window as unknown as {
      __bsTerm?: {
        insert: boolean
        paneCount: number
        activeIsAgent: boolean
        activeAgentBridgeId: string | null
      }
    }).__bsTerm = {
      insert: state.insert,
      paneCount: tab ? leavesOf(tab.root).length : 0,
      // RV2 — lets useVimNav branch focus routing (agent input vs xterm)
      // without subscribing to the store. Status is NOT mirrored here (it
      // changes every frame — would churn); read it via useClaudeStatus.
      activeIsAgent: activeLeaf?.agent != null,
      // The active agent's bridgeId — used to focus the RIGHT pane's input.
      activeAgentBridgeId: activeLeaf?.agent?.bridgeId ?? null,
    }
  } catch {
    /* SSR / non-browser — ignore */
  }
  listeners.forEach(l => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Cached snapshot: `state` is only ever REPLACED (never mutated in place),
// so returning it directly is a stable ref between mutations.
function getSnapshot(): TermPanesState {
  return state
}

export function useTermPanes(): TermPanesState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// Seed the window mirror once at module load so useVimNav can read termMode
// before any component subscribes.
try {
  ;(window as unknown as {
    __bsTerm?: {
      insert: boolean
      paneCount: number
      activeIsAgent: boolean
      activeAgentBridgeId: string | null
    }
  }).__bsTerm = {
    insert: state.insert,
    paneCount: 1,
    activeIsAgent: false,
    activeAgentBridgeId: null,
  }
} catch {
  /* noop */
}

// ---- tree helpers (pure) ----------------------------------------------

/** All leaves of a subtree, left-to-right. */
export function leavesOf(node: Node): Leaf[] {
  if (node.kind === 'leaf') return [node]
  return [...leavesOf(node.a), ...leavesOf(node.b)]
}

function findLeaf(node: Node, paneId: string): Leaf | null {
  if (node.kind === 'leaf') return node.paneId === paneId ? node : null
  return findLeaf(node.a, paneId) ?? findLeaf(node.b, paneId)
}

/** Return a new tree with `paneId`'s leaf replaced by `replacer(leaf)`. */
function mapLeaf(node: Node, paneId: string, replacer: (l: Leaf) => Node): Node {
  if (node.kind === 'leaf') {
    return node.paneId === paneId ? replacer(node) : node
  }
  return { ...node, a: mapLeaf(node.a, paneId, replacer), b: mapLeaf(node.b, paneId, replacer) }
}

/**
 * Remove `paneId`'s leaf, collapsing the parent split into the sibling.
 * Returns the new root, or null if the removed leaf was the whole tree.
 */
function removeLeaf(node: Node, paneId: string): Node | null {
  if (node.kind === 'leaf') return node.paneId === paneId ? null : node
  const a = removeLeaf(node.a, paneId)
  const b = removeLeaf(node.b, paneId)
  if (a === null) return b // sibling promoted
  if (b === null) return a
  return { ...node, a, b }
}

const activeTab = (s: TermPanesState): Tab =>
  s.tabs.find(t => t.id === s.activeTabId) ?? s.tabs[0]

function replaceTab(s: TermPanesState, tabId: string, next: Tab): TermPanesState {
  return { ...s, tabs: s.tabs.map(t => (t.id === tabId ? next : t)) }
}

// ---- pty lifecycle registration (lifted out of Terminal) ---------------

/** Called by a <Terminal> leaf once it has spawned its pty. */
export function registerPty(paneId: string, ptyId: number): void {
  const tab = state.tabs.find(t => findLeaf(t.root, paneId))
  if (!tab) return
  const next = { ...tab, root: mapLeaf(tab.root, paneId, l => ({ ...l, ptyId })) }
  state = replaceTab(state, tab.id, next)
  emit()
}

// ---- mutations ---------------------------------------------------------

/** Set the cwd used for freshly-spawned shells (from the active project). */
export function setDefaultCwd(cwd: string): void {
  // Only seed the very first leaf if it never got a cwd (app boot before
  // projects resolved). Existing shells are untouched — persistence.
  const tab = activeTab(state)
  const leaves = leavesOf(tab.root)
  if (leaves.length === 1 && leaves[0].ptyId === null && leaves[0].cwd === '') {
    const next = { ...tab, root: mapLeaf(tab.root, leaves[0].paneId, l => ({ ...l, cwd })) }
    state = replaceTab(state, tab.id, next)
    emit()
  }
  _lastCwd = cwd
}

let _lastCwd = ''
function spawnCwd(): string {
  const tab = activeTab(state)
  const active = findLeaf(tab.root, tab.activePaneId)
  return active?.cwd || _lastCwd || ''
}

export function focusPane(paneId: string): void {
  const tab = activeTab(state)
  if (tab.activePaneId === paneId) return
  state = replaceTab(state, tab.id, { ...tab, activePaneId: paneId })
  emit()
}

/** Split the active pane; new shell takes cwd of the active pane. */
export function splitActive(dir: SplitDir): void {
  const tab = activeTab(state)
  const leaf = newLeaf(spawnCwd())
  const next: Tab = {
    ...tab,
    root: mapLeaf(tab.root, tab.activePaneId, existing => ({
      kind: 'split',
      dir,
      ratio: 0.5,
      a: existing,
      b: leaf,
    })),
    activePaneId: leaf.paneId,
  }
  state = replaceTab(state, tab.id, next)
  emit()
}

/**
 * RV2 — split the active pane and put a fresh AGENT leaf in the new half.
 * Mirrors splitActive exactly but (a) inserts an agent leaf and (b) takes cwd
 * from the caller (the picked project path) rather than spawnCwd(). Always a
 * vertical seam (side-by-side) so the agent gets readable width.
 */
export function spawnAgent(
  projectId: string,
  cwd: string,
  sessionId: string,
  permissionMode?: 'acceptEdits' | 'default' | 'plan',
): void {
  const tab = activeTab(state)
  const leaf = newAgentLeaf(cwd, projectId, sessionId, permissionMode)
  const next: Tab = {
    ...tab,
    root: mapLeaf(tab.root, tab.activePaneId, existing => ({
      kind: 'split',
      dir: 'v',
      ratio: 0.5,
      a: existing,
      b: leaf,
    })),
    activePaneId: leaf.paneId,
  }
  state = replaceTab(state, tab.id, next)
  emit()
}

/** Close the active pane. If it's the last pane in the tab, close the tab. */
export function closeActivePane(): { killPtyId: number | null; killBridgeId: string | null } {
  const tab = activeTab(state)
  const leaf = findLeaf(tab.root, tab.activePaneId)
  const killPtyId = leaf?.ptyId ?? null
  // RV2 — an agent leaf has ptyId:null; the caller kills its claude session
  // via killBridgeId (claude_kill) instead of killing a pty.
  const killBridgeId = leaf?.agent?.bridgeId ?? null
  const newRoot = removeLeaf(tab.root, tab.activePaneId)

  if (newRoot === null) {
    // Last pane in this tab -> close the tab (unless it's the last tab).
    if (state.tabs.length === 1) {
      // Keep one empty leaf alive so the surface never goes blank.
      const fresh = makeInitialTab(_lastCwd)
      state = { ...state, tabs: [fresh], activeTabId: fresh.id }
    } else {
      const remaining = state.tabs.filter(t => t.id !== tab.id)
      state = { ...state, tabs: remaining, activeTabId: remaining[0].id }
    }
  } else {
    // Focus the first surviving leaf.
    const survivor = leavesOf(newRoot)[0]
    state = replaceTab(state, tab.id, { ...tab, root: newRoot, activePaneId: survivor.paneId })
  }
  emit()
  return { killPtyId, killBridgeId }
}

export function newTab(): void {
  const tab = makeInitialTab(spawnCwd())
  state = { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id }
  emit()
}

export function switchTab(index: number): void {
  const tab = state.tabs[index]
  if (!tab || tab.id === state.activeTabId) return
  state = { ...state, activeTabId: tab.id }
  emit()
}

export function cycleTab(delta: number): void {
  if (state.tabs.length < 2) return
  const idx = state.tabs.findIndex(t => t.id === state.activeTabId)
  const next = state.tabs[(idx + delta + state.tabs.length) % state.tabs.length]
  state = { ...state, activeTabId: next.id }
  emit()
}

// ---- directional focus move (C-w h/j/k/l) ------------------------------
//
// Geometry-free heuristic that matches how humans read a split tree: walk
// from the active leaf up to the first ancestor split whose orientation
// matches the requested direction and where the active pane sits on the
// "from" side; then descend into the sibling picking the nearest edge.

interface Rect { x: number; y: number; w: number; h: number }

/** Compute normalized rects (0..1) for every leaf in the tree. */
function layout(node: Node, rect: Rect, out: Map<string, Rect>): void {
  if (node.kind === 'leaf') {
    out.set(node.paneId, rect)
    return
  }
  if (node.dir === 'v') {
    // vertical seam -> side by side (left|right)
    const wa = rect.w * node.ratio
    layout(node.a, { ...rect, w: wa }, out)
    layout(node.b, { x: rect.x + wa, y: rect.y, w: rect.w - wa, h: rect.h }, out)
  } else {
    // horizontal seam -> stacked (top/bottom)
    const ha = rect.h * node.ratio
    layout(node.a, { ...rect, h: ha }, out)
    layout(node.b, { x: rect.x, y: rect.y + ha, w: rect.w, h: rect.h - ha }, out)
  }
}

export function moveFocus(dir: 'h' | 'j' | 'k' | 'l'): void {
  const tab = activeTab(state)
  const rects = new Map<string, Rect>()
  layout(tab.root, { x: 0, y: 0, w: 1, h: 1 }, rects)
  const cur = rects.get(tab.activePaneId)
  if (!cur) return
  const cx = cur.x + cur.w / 2
  const cy = cur.y + cur.h / 2

  let best: { paneId: string; d: number } | null = null
  for (const [paneId, r] of rects) {
    if (paneId === tab.activePaneId) continue
    const rx = r.x + r.w / 2
    const ry = r.y + r.h / 2
    // Must lie in the requested direction.
    const inDir =
      (dir === 'h' && rx < cx) ||
      (dir === 'l' && rx > cx) ||
      (dir === 'k' && ry < cy) ||
      (dir === 'j' && ry > cy)
    if (!inDir) continue
    // Distance: primary axis + small penalty on the cross axis.
    const primary = dir === 'h' || dir === 'l' ? Math.abs(rx - cx) : Math.abs(ry - cy)
    const cross = dir === 'h' || dir === 'l' ? Math.abs(ry - cy) : Math.abs(rx - cx)
    const d = primary + cross * 0.5
    if (!best || d < best.d) best = { paneId, d }
  }
  if (best) focusPane(best.paneId)
}

/** C-w w — cycle to the next leaf in reading order. */
export function cyclePane(): void {
  const tab = activeTab(state)
  const leaves = leavesOf(tab.root)
  if (leaves.length < 2) return
  const idx = leaves.findIndex(l => l.paneId === tab.activePaneId)
  const next = leaves[(idx + 1) % leaves.length]
  focusPane(next.paneId)
}

// ---- zoom --------------------------------------------------------------

let _zoomed: string | null = null
const zoomListeners = new Set<() => void>()
export function subscribeZoom(l: () => void): () => void {
  zoomListeners.add(l)
  return () => zoomListeners.delete(l)
}
export function getZoom(): string | null {
  return _zoomed
}
export function toggleZoom(): void {
  const tab = activeTab(state)
  _zoomed = _zoomed ? null : tab.activePaneId
  zoomListeners.forEach(l => l())
}
export function useZoom(): string | null {
  return useSyncExternalStore(subscribeZoom, getZoom, getZoom)
}

// ---- insert vs pane-op mode -------------------------------------------

export function setInsert(b: boolean): void {
  if (state.insert === b) return
  state = { ...state, insert: b }
  emit()
}
