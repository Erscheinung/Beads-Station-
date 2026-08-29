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
  /**
   * RV3-B — additive file-nav payload, mirroring `agent?`. Absent => shell or
   * agent leaf; present => this leaf hosts a read-only FileTree rooted at
   * rootPath (ptyId stays null, no bridgeId). Same optional-field discipline
   * so the 7 tree helpers stay untouched (they only match on `kind`).
   */
  fileNav?: {
    rootPath: string
  }
}

/** Named guard for call-site readability (G5). */
export function isAgentLeaf(l: Leaf): boolean {
  return l.agent != null
}

/** RV3-B — file-nav leaf guard, mirrors isAgentLeaf. */
export function isFileNavLeaf(l: Leaf): boolean {
  return l.fileNav != null
}

export interface Split {
  kind: 'split'
  /** Stable identity so the renderer can key wrapper divs across reflows
   *  (Code-bqz: without it React matches wrappers by position and a keyed
   *  pane changing siblings/ratio remounts its whole subtree). */
  splitId: string
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

/**
 * Code-mkv — advance `_seq` past the largest numeric suffix among `ids` so that
 * ids minted after a restore never collide with rehydrated ones. `_seq` resets
 * to 0 every reload; a persisted tree carrying `pane7`/`split3`/`agent2` would
 * otherwise get `pane1`… on the next split, and the tree helpers match by exact
 * string — a duplicate id would mutate/remove the wrong leaf.
 */
function bumpSeqPast(ids: string[]): void {
  let max = _seq
  for (const id of ids) {
    const m = /(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  _seq = max
}

/** All ids (paneId/splitId/agent bridgeId) in a subtree, for bumpSeqPast. */
function idsOf(node: Node): string[] {
  if (node.kind === 'leaf') {
    return node.agent ? [node.paneId, node.agent.bridgeId] : [node.paneId]
  }
  return [node.splitId, ...idsOf(node.a), ...idsOf(node.b)]
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

/** RV3-B — construct a file-nav leaf rooted at a project path. */
function newFileNavLeaf(rootPath: string): Leaf {
  return {
    kind: 'leaf',
    paneId: uid('pane'),
    ptyId: null,
    cwd: rootPath,
    fileNav: { rootPath },
  }
}

// ---- initial state: one tab, one leaf, no pty yet ----------------------

function makeInitialTab(cwd: string): Tab {
  const leaf = newLeaf(cwd)
  return { id: uid('tab'), root: leaf, activePaneId: leaf.paneId }
}

function makeInitialState(cwd: string): TermPanesState {
  const tab = makeInitialTab(cwd)
  return { tabs: [tab], activeTabId: tab.id, insert: false }
}

// Code-x8p — the pane surface is now keyed by PROJECT. Each project owns its
// own pane/tab/split tree; switching project swaps the whole visible surface so
// a project's shells + agent panes are its own and never bleed across a switch
// (the old design shared one global tree, so a Bug-Bash tab could show a
// Beads-Station shell = "everything gone" to the user).
//
// `state` remains the ACTIVE project's TermPanesState — every mutation below
// still operates on `state` unchanged. On a project switch we stash the current
// `state` back into PROJECTS under the outgoing id and load (or lazily create)
// the incoming project's state. In-memory only, matching the prior model (the
// tree was never persisted across a full reload; only activeProjectId is).
const BOOT_PROJECT = ''
let activeProjectId = BOOT_PROJECT
const PROJECTS = new Map<string, TermPanesState>()

let state: TermPanesState = makeInitialState('')
PROJECTS.set(BOOT_PROJECT, state)

// ---- persistence (Code-mkv) --------------------------------------------
//
// The whole per-project pane surface (tab/split tree incl. ratios, cwds, agent
// + file-nav leaves) is serialized to localStorage so a reload restores each
// project's layout. Volatile handles are stripped: ptyId (the shell respawns
// fresh on mount — Terminal ignores an incoming id), so it's reset to null.
// Agent bridgeId IS kept: it's the resume key (bs.claude.session:<bridgeId>),
// so a rehydrated agent leaf resumes its claude session on remount.
//
// Writes are debounced on emit() (a focus/insert burst -> one stringify). The
// BOOT_PROJECT surface is never persisted (it's the pre-project scratch leaf).

const PERSIST_KEY = 'beads-station.termPanes'
const PERSIST_VERSION = 1

/** Deep-copy a node, resetting every leaf's ptyId to null (stale after reload). */
function sanitizeNode(node: Node): Node {
  if (node.kind === 'leaf') return { ...node, ptyId: null }
  return { ...node, a: sanitizeNode(node.a), b: sanitizeNode(node.b) }
}

function sanitizeState(s: TermPanesState): TermPanesState {
  return {
    ...s,
    tabs: s.tabs.map(t => ({ ...t, root: sanitizeNode(t.root) })),
    insert: false,
  }
}

export function serializeProjects(): string {
  // Snapshot every project surface EXCEPT the boot scratch. The live `state`
  // is the active project's surface; the stashed copy in PROJECTS may be stale,
  // so overwrite the active entry with `state` before reading the map.
  const map: Record<string, TermPanesState> = {}
  const snapshot = new Map(PROJECTS)
  if (activeProjectId !== BOOT_PROJECT) snapshot.set(activeProjectId, state)
  for (const [pid, s] of snapshot) {
    if (pid === BOOT_PROJECT) continue
    map[pid] = sanitizeState(s)
  }
  return JSON.stringify({ v: PERSIST_VERSION, projects: map })
}

export function restoreProjects(json: string | null): void {
  if (!json) return
  try {
    const parsed = JSON.parse(json) as { v?: number; projects?: Record<string, TermPanesState> }
    if (parsed.v !== PERSIST_VERSION || !parsed.projects) return
    const allIds: string[] = []
    for (const [pid, s] of Object.entries(parsed.projects)) {
      if (!s?.tabs?.length) continue
      PROJECTS.set(pid, sanitizeState(s))
      for (const t of s.tabs) allIds.push(t.id, ...idsOf(t.root))
    }
    bumpSeqPast(allIds)
  } catch {
    /* corrupt payload — ignore, start fresh */
  }
}

let _persistTimer: ReturnType<typeof setTimeout> | null = null
function schedulePersist(): void {
  if (_persistTimer !== null) return
  _persistTimer = setTimeout(() => {
    _persistTimer = null
    try {
      localStorage.setItem(PERSIST_KEY, serializeProjects())
    } catch {
      /* quota / non-browser — ignore */
    }
  }, 150)
}

// Rehydrate persisted surfaces BEFORE any project switch. restore only fills
// PROJECTS (not the live `state`), and setActiveProject prefers an existing
// PROJECTS entry over adopting the boot leaf, so a restored project wins.
try {
  restoreProjects(localStorage.getItem(PERSIST_KEY))
} catch {
  /* non-browser — ignore */
}

/** True when a state is a pristine boot surface (one empty, un-spawned leaf). */
function isPristine(s: TermPanesState): boolean {
  if (s.tabs.length !== 1) return false
  const leaves = leavesOf(s.tabs[0].root)
  return leaves.length === 1 && leaves[0].ptyId === null && leaves[0].cwd === '' && !leaves[0].agent && !leaves[0].fileNav
}

/**
 * Code-x8p — make `projectId` the active pane surface. Stashes the current
 * surface under the outgoing id and restores (or lazily creates) this one.
 * On the very first switch away from the boot surface, if the boot surface is
 * still pristine it is ADOPTED as this project's initial state (seeded to cwd)
 * so the boot terminal becomes the first project's terminal rather than being
 * discarded. No-op if already active.
 */
export function setActiveProject(projectId: string, cwd: string): void {
  if (projectId === activeProjectId) return
  // Stash the outgoing surface.
  PROJECTS.set(activeProjectId, state)

  let next = PROJECTS.get(projectId)
  if (!next) {
    // Adopt a pristine boot surface for the first real project switch.
    if (activeProjectId === BOOT_PROJECT && isPristine(state)) {
      const bootTab = state.tabs[0]
      const seeded: TermPanesState = {
        ...state,
        tabs: [{ ...bootTab, root: mapLeaf(bootTab.root, bootTab.activePaneId, l => ({ ...l, cwd })) }],
      }
      next = seeded
      PROJECTS.delete(BOOT_PROJECT)
    } else {
      next = makeInitialState(cwd)
    }
    PROJECTS.set(projectId, next)
  }

  activeProjectId = projectId
  state = next
  _lastCwd = cwd
  emit()
}

const listeners = new Set<() => void>()

// Code-aod — reconcile signature. App.tsx only subscribes to the pane store to
// re-run the debounced claude_reconcile effect, which cares about ONE slice:
// the set of live agent bridges. Subscribing to the whole state re-rendered App
// (and its whole tree: Board, TerminalPanes, ClaudeChat, Statusline) on every
// focusPane/setInsert/registerPty emit. Instead we maintain a cached signature
// string of the reconcile-relevant slice and let App subscribe to THAT via
// useTermPanesSignature; useSyncExternalStore bails the render when the string
// is === unchanged, so pure focus/insert churn (which doesn't touch the bridge
// set) no longer re-renders App. Recomputed only inside emit() (and seeded at
// module load) so getSig returns a stable ref between mutations (the R3.5
// render-loop lesson: getSnapshot must not build a fresh value each call).
let _sig = ''
function computeSig(): string {
  // allAgentBridges() spans every project's surface; the active tab id +
  // paneCount round out the slice the reconcile effect keys on. Sorted so a
  // reorder that doesn't change membership stays stable.
  const bridges = allAgentBridges().slice().sort().join(',')
  return `${activeProjectId}|${state.activeTabId}|${bridges}`
}

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
        activeIsFileNav: boolean
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
      // RV3-B — active pane is a file-nav tree; useVimNav must not route keys
      // to xterm, the FileTree handles j/k/h/l/Enter on its own focused root.
      activeIsFileNav: activeLeaf?.fileNav != null,
    }
  } catch {
    /* SSR / non-browser — ignore */
  }
  _sig = computeSig()
  schedulePersist()
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

// Code-aod — reconcile-slice signature (see computeSig / _sig above). Returns a
// primitive string, so useSyncExternalStore skips the render whenever the slice
// is unchanged. App subscribes to this instead of useTermPanes so focus/insert
// churn no longer re-renders the whole tree.
function getSig(): string {
  return _sig
}

export function useTermPanesSignature(): string {
  return useSyncExternalStore(subscribe, getSig, getSig)
}

/** Non-hook read of the current reconcile signature (Code-1cs test probe). */
export function termPanesSignature(): string {
  return _sig
}

/** Non-hook read of the active tab's root node (Code-mkv test probe — the tree
 *  isn't otherwise exported; used to assert setRatio / restore in unit tests). */
export function activeTabRoot(): Node {
  return activeTab(state).root
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
// Seed the reconcile signature so useTermPanesSignature has a stable value
// before the first emit (getSig must not build a fresh string per call).
_sig = computeSig()

// ---- tree helpers (pure) ----------------------------------------------

/** All leaves of a subtree, left-to-right. */
export function leavesOf(node: Node): Leaf[] {
  if (node.kind === 'leaf') return [node]
  return [...leavesOf(node.a), ...leavesOf(node.b)]
}

/**
 * RV3-C — resolve the agent pane to send a file path to. Preference:
 *   1. the currently-active pane, if it's an agent (user's focus intent)
 *   2. otherwise the sole agent pane, if exactly one exists
 *   3. otherwise null (ambiguous with 2+ agents and none focused, or none).
 * Returns the target bridgeId. Scoped to the active tab.
 */
export function resolveTargetAgentBridge(): string | null {
  const tab = activeTab(state)
  const agents = leavesOf(tab.root).filter(l => l.agent != null)
  if (agents.length === 0) return null
  const active = findLeaf(tab.root, tab.activePaneId)
  if (active?.agent != null) return active.agent.bridgeId
  if (agents.length === 1) return agents[0].agent!.bridgeId
  return null // ambiguous — caller should hint the user to focus an agent
}

/**
 * RV3.7 (Code-uu5) — every agent bridgeId live across ALL tabs (not just the
 * active one). The FE reconciler passes this to the backend claude_reconcile
 * so any SESSIONS entry whose bridge is no longer in the tree gets reaped;
 * without it, an agent leaf discarded by a tab reset (not via closeActivePane)
 * leaks its claude child until app exit.
 *
 * Code-x8p — now the pane surface is per-project, so an agent living in a
 * NON-active project's surface must still count as live, or switching projects
 * would reap every hidden project's agents. Walk ALL projects' states plus the
 * in-hand `state` (the active one, which is stashed lazily on switch).
 */
export function allAgentBridges(): string[] {
  const out: string[] = []
  const seen = new Set<TermPanesState>()
  const collect = (s: TermPanesState) => {
    if (seen.has(s)) return
    seen.add(s)
    for (const tab of s.tabs) {
      for (const leaf of leavesOf(tab.root)) {
        if (leaf.agent != null) out.push(leaf.agent.bridgeId)
      }
    }
  }
  collect(state)
  for (const s of PROJECTS.values()) collect(s)
  return out
}

/** Return the ptyId of the active shell pane, or null if active pane is an agent/filenav. */
export function resolveActiveShellPtyId(): number | null {
  const tab = activeTab(state)
  const active = findLeaf(tab.root, tab.activePaneId)
  if (active == null || active.agent != null || active.fileNav != null) return null
  return active.ptyId ?? null
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

/** Return a new tree with `splitId`'s Split node replaced by `replacer(split)`.
 *  Ref-preserving: returns the same node when nothing in the subtree changed. */
function mapSplit(node: Node, splitId: string, replacer: (s: Split) => Split): Node {
  if (node.kind === 'leaf') return node
  const self = node.splitId === splitId ? replacer(node) : node
  const a = mapSplit(self.a, splitId, replacer)
  const b = mapSplit(self.b, splitId, replacer)
  if (self === node && a === node.a && b === node.b) return node
  return { ...self, a, b }
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

/**
 * Code-mkv — set a split's `ratio` (fraction taken by child `a`), clamped so
 * neither half can be dragged to zero. Immutable: rebuilds the active tab's
 * tree via mapSplit, so the keyed wrappers survive (a ratio change is a style
 * change on a stable-keyed wrapper, never a tree-shape change — no remount).
 */
export function setRatio(splitId: string, ratio: number): void {
  const clamped = Math.min(0.95, Math.max(0.05, ratio))
  const tab = activeTab(state)
  const next = mapSplit(tab.root, splitId, s => (s.ratio === clamped ? s : { ...s, ratio: clamped }))
  if (next === tab.root) return
  state = replaceTab(state, tab.id, { ...tab, root: next })
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
      splitId: uid('split'),
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
      splitId: uid('split'),
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

/** RV3-B — split the active pane and mount a file-nav tree rooted at `rootPath`.
 *  Mirrors spawnAgent; no pty, no claude session. */
export function spawnFileNav(rootPath: string): void {
  const tab = activeTab(state)
  const leaf = newFileNavLeaf(rootPath)
  const next: Tab = {
    ...tab,
    root: mapLeaf(tab.root, tab.activePaneId, existing => ({
      kind: 'split',
      splitId: uid('split'),
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
