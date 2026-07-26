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
import {
  useTermPanes,
  useZoom,
  registerPty,
  focusPane,
  setInsert,
  switchTab,
  type Node,
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
  paneId,
  cwd,
  ctx,
}: {
  paneId: string
  cwd: string
  ctx: RenderCtx
}) {
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
        cwd={cwd}
        onSpawn={onSpawn}
        focused={isActive && ctx.termFocused}
        insert={isActive && ctx.termFocused && ctx.insert}
      />
    </div>
  )
}

function renderNode(node: Node, ctx: RenderCtx): React.ReactNode {
  if (node.kind === 'leaf') {
    return <PaneLeaf key={node.paneId} paneId={node.paneId} cwd={node.cwd} ctx={ctx} />
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
