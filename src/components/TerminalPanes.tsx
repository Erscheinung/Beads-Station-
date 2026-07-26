// Beads Station — RV1: multiplexed terminal surface.
//
// Renders the termPanes store: a tab strip + the active tab's split tree.
// Each leaf is a <Terminal>, keyed by paneId so reflow preserves the shell.
//
// Zoom keeps every pane MOUNTED (never respawn a shell) — the zoomed pane's
// wrapper is promoted to position:absolute/inset:0 over the region while
// siblings are visually hidden. Nothing unmounts.

import { invoke } from '@tauri-apps/api/core'
import { Terminal } from './Terminal'
import { ClaudeChat } from './ClaudeChat'
import { FileTree } from './FileTree'
import { useClaudeStatus } from '../state/claudeStatus'
import {
  useTermPanes,
  useZoom,
  registerPty,
  focusPane,
  setInsert,
  switchTab,
  type Node,
  type Leaf,
} from '../state/termPanes'
import { setFocused } from '../state/vim'

function onSpawn(paneId: string, ptyId: number) {
  registerPty(paneId, ptyId)
}

interface RenderCtx {
  activePaneId: string
  termFocused: boolean
  insert: boolean
  /** when set, this paneId fills the region; all others are hidden. */
  zoomed: string | null
}

function PaneLeaf({
  leaf,
  ctx,
}: {
  leaf: Leaf
  ctx: RenderCtx
}) {
  // RV2 — an agent leaf hosts a ClaudeChat instead of an xterm shell.
  if (leaf.agent) return <AgentPaneLeaf leaf={leaf} ctx={ctx} />
  // RV3-B — a file-nav leaf hosts a read-only FileTree.
  if (leaf.fileNav) return <FileNavPaneLeaf leaf={leaf} ctx={ctx} />

  const paneId = leaf.paneId
  const isActive = paneId === ctx.activePaneId
  const isZoomed = ctx.zoomed === paneId
  const hiddenByZoom = ctx.zoomed !== null && !isZoomed
  return (
    <div
      onMouseDown={() => {
        focusPane(paneId)
        setFocused('terminal')
        setInsert(true)
      }}
      style={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        position: isZoomed ? 'absolute' : 'relative',
        inset: isZoomed ? 0 : undefined,
        zIndex: isZoomed ? 5 : undefined,
        background: 'var(--bs-bg)',
        // A zoomed pane covers the whole region; siblings stay mounted but
        // hidden so their shells (and running processes) keep going.
        visibility: hiddenByZoom ? 'hidden' : 'visible',
        // Focus ring mirrors the sidebar's inset blue rule when this pane is
        // the active pane AND the terminal region holds vim focus.
        boxShadow: isActive && ctx.termFocused ? 'inset 0 0 0 1px var(--bs-blue)' : undefined,
      }}
    >
      <Terminal
        paneId={paneId}
        cwd={leaf.cwd}
        onSpawn={onSpawn}
        focused={isActive && ctx.termFocused}
        insert={isActive && ctx.termFocused && ctx.insert}
      />
    </div>
  )
}

// RV2 — agent leaf: same focus-ring/zoom wrapper as PaneLeaf, but hosts a
// ClaudeChat bound to the leaf's (bridgeId, projectId, sessionId). The status
// dot is read reactively via useClaudeStatus(bridgeId) — status lives in the
// claudeStatus atom, NEVER on the termPanes leaf (it changes every frame and
// would churn the store). Keyed by paneId upstream so reflow re-parents (the
// ClaudeChat subtree + its stream subscription survive split/tab reflow).
const STATUS_DOT: Record<string, string> = {
  running: 'var(--bs-green)',
  'awaiting-input': 'var(--bs-yellow)',
  error: 'var(--bs-red)',
  idle: 'var(--bs-fg-muted)',
}
function AgentPaneLeaf({ leaf, ctx }: { leaf: Leaf; ctx: RenderCtx }) {
  const a = leaf.agent!
  const isActive = leaf.paneId === ctx.activePaneId
  const isZoomed = ctx.zoomed === leaf.paneId
  const hiddenByZoom = ctx.zoomed !== null && !isZoomed
  const status = useClaudeStatus(a.bridgeId)
  return (
    <div
      onMouseDown={() => {
        // RV2 — focus the pane, but DON'T force insert here. If the click lands
        // on the input, its onFocus sets insert=true (real focus == insert). If
        // it lands on the header/body, we stay in pane-op mode so leader/C-w
        // work — forcing insert with no focused input is the desync that traps
        // the user.
        focusPane(leaf.paneId)
        setFocused('terminal')
      }}
      style={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        position: isZoomed ? 'absolute' : 'relative',
        inset: isZoomed ? 0 : undefined,
        zIndex: isZoomed ? 5 : undefined,
        background: 'var(--bs-bg)',
        display: 'flex',
        flexDirection: 'column',
        visibility: hiddenByZoom ? 'hidden' : 'visible',
        boxShadow: isActive && ctx.termFocused ? 'inset 0 0 0 1px var(--bs-blue)' : undefined,
      }}
    >
      {/* Pane header — status at a glance (req 5), keyed by bridgeId so two
          same-project panes show independent dots. */}
      <div style={{
        height: 20, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
        padding: '0 8px', fontSize: 10, color: 'var(--bs-fg-muted)',
        background: 'var(--bs-bg-elev)', borderBottom: '1px solid var(--bs-border)',
      }}>
        <span style={{
          display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
          background: STATUS_DOT[status] ?? STATUS_DOT.idle, flexShrink: 0,
        }} />
        <span>agent · {a.projectId} · {status}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ClaudeChat
          projectId={a.projectId}
          bridgeId={a.bridgeId}
          cwd={leaf.cwd}
          sessionId={a.sessionId}
          permissionMode={a.permissionMode}
          active={isActive && ctx.termFocused}
        />
      </div>
    </div>
  )
}

// RV3-B — file-nav leaf: same focus-ring/zoom wrapper, hosts a read-only
// FileTree rooted at fileNav.rootPath. On becoming the active+focused pane we
// focus the tree's root element so its scoped vim keydown (j/k/h/l/Enter)
// fires. Header click focuses the pane (pane-op stays available via leader).
function FileNavPaneLeaf({ leaf, ctx }: { leaf: Leaf; ctx: RenderCtx }) {
  const rootPath = leaf.fileNav!.rootPath
  const isActive = leaf.paneId === ctx.activePaneId
  const isZoomed = ctx.zoomed === leaf.paneId
  const hiddenByZoom = ctx.zoomed !== null && !isZoomed
  const focused = isActive && ctx.termFocused
  return (
    <div
      onMouseDown={() => {
        focusPane(leaf.paneId)
        setFocused('terminal')
      }}
      style={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        position: isZoomed ? 'absolute' : 'relative',
        inset: isZoomed ? 0 : undefined,
        zIndex: isZoomed ? 5 : undefined,
        background: 'var(--bs-bg)',
        display: 'flex',
        flexDirection: 'column',
        visibility: hiddenByZoom ? 'hidden' : 'visible',
        boxShadow: isActive && ctx.termFocused ? 'inset 0 0 0 1px var(--bs-blue)' : undefined,
      }}
    >
      <div style={{
        height: 20, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
        padding: '0 8px', fontSize: 10, color: 'var(--bs-fg-muted)',
        background: 'var(--bs-bg-elev)', borderBottom: '1px solid var(--bs-border)',
      }}>
        <span className="codicon codicon-folder-opened" style={{ fontSize: 12 }} aria-hidden />
        <span>files · {rootPath.split('/').pop()}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <FileTree rootPath={rootPath} active={focused} />
      </div>
    </div>
  )
}

function renderNode(node: Node, ctx: RenderCtx): React.ReactNode {
  if (node.kind === 'leaf') {
    return <PaneLeaf key={node.paneId} leaf={node} ctx={ctx} />
  }
  // dir 'v' = vertical seam = children side-by-side (row).
  // dir 'h' = horizontal seam = children stacked (column).
  const isRow = node.dir === 'v'
  const aPct = `${node.ratio * 100}%`
  const bPct = `${(1 - node.ratio) * 100}%`
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isRow ? 'row' : 'column',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        gap: 1, // 1px hairline seam between children
        background: 'var(--bs-border)',
      }}
    >
      <div style={{ flexBasis: aPct, minWidth: 0, minHeight: 0, background: 'var(--bs-bg)', position: 'relative' }}>
        {renderNode(node.a, ctx)}
      </div>
      <div style={{ flexBasis: bPct, minWidth: 0, minHeight: 0, background: 'var(--bs-bg)', position: 'relative' }}>
        {renderNode(node.b, ctx)}
      </div>
    </div>
  )
}

export function TerminalPanes({ termFocused }: { termFocused: boolean }) {
  const { tabs, activeTabId, insert } = useTermPanes()
  const zoomed = useZoom()
  const tab = tabs.find(t => t.id === activeTabId) ?? tabs[0]
  const ctx: RenderCtx = { activePaneId: tab.activePaneId, termFocused, insert, zoomed }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      {/* tab strip — only when >1 tab, to keep the single-shell case clean */}
      {tabs.length > 1 && (
        <div
          className="bs-tabstrip"
          style={{
            display: 'flex',
            gap: 1,
            background: 'var(--bs-border-faint)',
            flexShrink: 0,
            overflowX: 'auto',
          }}
        >
          {tabs.map((t, i) => (
            <button
              key={t.id}
              onMouseDown={() => switchTab(i)}
              style={{
                padding: '2px 10px',
                fontSize: 10,
                fontFamily: 'inherit',
                border: 'none',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                color: t.id === activeTabId ? 'var(--bs-fg)' : 'var(--bs-fg-muted)',
                background: t.id === activeTabId ? 'var(--bs-bg-elev)' : 'var(--bs-bg)',
                boxShadow: t.id === activeTabId ? 'inset 0 -1px 0 var(--bs-blue)' : undefined,
              }}
            >
              {i + 1}·zsh
            </button>
          ))}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>{renderNode(tab.root, ctx)}</div>
    </div>
  )
}

export function killPty(id: number): void {
  invoke('pty_kill', { id }).catch(() => {})
}
