// Beads Station — RV1: multiplexed terminal surface.
//
// Renders the termPanes store: a tab strip + the active tab's split tree.
// Each leaf is a <Terminal>, keyed by paneId so reflow preserves the shell.
//
// Zoom keeps every pane MOUNTED (never respawn a shell) — the zoomed pane's
// wrapper is promoted to position:absolute/inset:0 over the region while
// siblings are visually hidden. Nothing unmounts.

import { useRef, useState } from 'react'
import './TerminalPanes.css'
import { invoke } from '@tauri-apps/api/core'
import { Terminal } from './Terminal'
import { ClaudeChat } from './ClaudeChat'
import { FileTree } from './FileTree'
import { useClaudeStatus } from '../state/claudeStatus'
import {
  useTermPanes,
  closeActivePane, unsplitToTabs, splitActive, toggleZoom, leavesOf,
  useZoom,
  registerPty,
  updatePaneScreen,
  activateRestoredPane,
  focusPane,
  setInsert,
  setRatio,
  switchTab, reorderTab,
  type Node,
  type Leaf,
} from '../state/termPanes'
import { setFocused } from '../state/vim'
import { clearObservedProviderSession, observedProviderSession } from '../state/sessionPreferences'
import { requestDestructiveAction } from '../state/destructiveActions'

function onSpawn(paneId: string, ptyId: number) {
  registerPty(paneId, ptyId)
}

function onScreen(paneId: string, screen: Parameters<typeof updatePaneScreen>[1]) {
  updatePaneScreen(paneId, screen)
}

function RestoredShell({ leaf }: { leaf: Leaf }) {
  return <div data-restored-pane={leaf.paneId} style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bs-bg)' }}>
    <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--bs-border)', color: 'var(--bs-yellow)', fontSize: 11 }}>
      Saved screen · previous shell is stopped · no live process attached
    </div>
    <pre aria-label="Saved terminal screen" style={{ flex: 1, minHeight: 0, overflow: 'auto', margin: 0, padding: 10, color: 'var(--bs-fg-muted)', whiteSpace: 'pre-wrap', font: 'inherit' }}>
      {leaf.savedScreen?.lines.join('\n') || 'No terminal screen was captured before the app stopped.'}
    </pre>
    <div style={{ padding: 8, borderTop: '1px solid var(--bs-border)' }}>
      <button onClick={() => activateRestoredPane(leaf.paneId)}>Start new shell</button>
    </div>
  </div>
}

interface RenderCtx {
  activePaneId: string
  termFocused: boolean
  insert: boolean
  /** when set, this paneId fills the region; all others are hidden. */
  zoomed: string | null
  viewEpoch: string
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
      {leaf.restored ? <RestoredShell leaf={leaf} /> : <Terminal
        paneId={paneId}
        cwd={leaf.cwd}
        onSpawn={onSpawn}
        onScreen={onScreen}
        focused={isActive && ctx.termFocused}
        insert={isActive && ctx.termFocused && ctx.insert}
        viewEpoch={ctx.viewEpoch}
      />}
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
  const provider = a.provider ?? 'claude'
  const observedId = observedProviderSession(provider, a.bridgeId)
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
        <span>agent · {a.projectId} · {leaf.restored ? 'saved context' : status}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {leaf.restored ? <div data-restored-provider={a.bridgeId} style={{ height: '100%', display: 'grid', placeContent: 'center', gap: 10, padding: 20, textAlign: 'center', color: 'var(--bs-fg-muted)' }}>
          <strong style={{ color: 'var(--bs-fg)' }}>Saved {provider === 'claude' ? 'Claude session' : 'Codex thread'}</strong>
          <span>{observedId ?? 'No provider-observed session ID'} · {a.configurationId ?? `native:${provider}`}</span>
          <span>This transcript context is restored. No live process is attached and no model turn was started.</span>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
            {provider === 'claude' && observedId && <button onClick={() => activateRestoredPane(leaf.paneId)}>Resume session</button>}
            <button onClick={() => {
              clearObservedProviderSession(provider, a.bridgeId)
              activateRestoredPane(leaf.paneId)
            }}>Start new session</button>
          </div>
        </div> : <ClaudeChat
          projectId={a.projectId}
          bridgeId={a.bridgeId}
          cwd={leaf.cwd}
          sessionId={a.sessionId}
          permissionMode={a.permissionMode}
          provider={provider}
          active={isActive && ctx.termFocused}
        />}
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

function nodeKey(node: Node): string {
  return node.kind === 'leaf' ? node.paneId : node.splitId
}

// Code-mkv — seam drag. The seam sits between the two halves of a split; on
// mousedown we read the flex container's rect (the seam's parentElement) and,
// on each mousemove, map the pointer position along the split axis to a ratio
// for child `a`. Mirrors App.tsx's startTerminalResize (window listeners +
// clamp), but writes to the termPanes store instead of React state.
function startSeamDrag(splitId: string, isRow: boolean, e: React.MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const container = (e.currentTarget as HTMLElement).parentElement
  if (!container) return
  const onMove = (ev: MouseEvent) => {
    const rect = container.getBoundingClientRect()
    const ratio = isRow
      ? (ev.clientX - rect.left) / rect.width
      : (ev.clientY - rect.top) / rect.height
    if (Number.isFinite(ratio)) setRatio(splitId, ratio)
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
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
  // Code-bqz: key the container + both halves by stable ids so React matches
  // wrappers by key, not tree position. Without this, splitting/reflowing a
  // sibling re-parented a keyed pane and remounted its whole ClaudeChat/Terminal
  // subtree (respawning claude children + the [ClaudeChat] starting burst).
  return (
    <div
      key={node.splitId}
      style={{
        display: 'flex',
        flexDirection: isRow ? 'row' : 'column',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        background: 'var(--bs-border)',
      }}
    >
      <div key={nodeKey(node.a)} style={{ flexBasis: aPct, minWidth: 0, minHeight: 0, background: 'var(--bs-bg)', position: 'relative' }}>
        {renderNode(node.a, ctx)}
      </div>
      {/* Code-mkv — draggable seam. 4px hit area, 1px visible hairline via the
          container background showing through. Keyed off splitId so it stays
          stable across reflows. */}
      <div
        key={`${node.splitId}-seam`}
        data-bs-split-seam={node.splitId}
        onMouseDown={e => startSeamDrag(node.splitId, isRow, e)}
        style={{
          flex: '0 0 1px',
          alignSelf: 'stretch',
          cursor: isRow ? 'col-resize' : 'row-resize',
          background: 'var(--bs-border)',
          position: 'relative',
          zIndex: 6,
          // Widen the hit area beyond the 1px hairline without shifting layout.
          ...(isRow
            ? { boxSizing: 'content-box' as const, padding: '0 1.5px', margin: '0 -1.5px' }
            : { boxSizing: 'content-box' as const, padding: '1.5px 0', margin: '-1.5px 0' }),
        }}
      />
      <div key={nodeKey(node.b)} style={{ flexBasis: bPct, minWidth: 0, minHeight: 0, background: 'var(--bs-bg)', position: 'relative' }}>
        {renderNode(node.b, ctx)}
      </div>
    </div>
  )
}

export function TerminalPanes({ termFocused, fullscreen = false }: { termFocused: boolean; fullscreen?: boolean }) {
  const { tabs, activeTabId, insert } = useTermPanes()
  const draggedTab = useRef<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const zoomed = useZoom()
  const tab = tabs.find(t => t.id === activeTabId) ?? tabs[0]
  const visibleZoom = leavesOf(tab.root).some(l => l.paneId === zoomed) ? zoomed : null
  const ctx: RenderCtx = {
    activePaneId: tab.activePaneId,
    termFocused,
    insert,
    zoomed: visibleZoom,
    viewEpoch: `${tab.id}:${visibleZoom ?? ''}:${fullscreen}`,
  }

  return (
    <div className={`bs-terminal-panes${fullscreen ? ' bs-terminal-panes--fullscreen' : ''}`} style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      <div className="bs-pane-actions" role="toolbar" aria-label="Terminal pane controls" aria-hidden={fullscreen}>
        <button onClick={() => { splitActive('v'); setFocused('terminal'); setInsert(true) }} title="Split side by side">Split right</button>
        <button onClick={() => { splitActive('h'); setFocused('terminal'); setInsert(true) }} title="Split top and bottom">Split down</button>
        <button onClick={unsplitToTabs} disabled={tab.root.kind === 'leaf'} title="Remove splits and keep every session in its own tab">Unsplit to tabs</button>
        <button onClick={toggleZoom} disabled={tab.root.kind === 'leaf'}>{visibleZoom ? 'Restore panes' : 'Zoom pane'}</button>
        <button onClick={closeFocusedPane} title="Close the focused pane and stop its shell or agent">Close pane</button>
      </div>
      {/* tab strip — only when >1 tab, to keep the single-shell case clean */}
      {tabs.length > 1 && (
        <div
          className="bs-tabstrip"
          aria-hidden={fullscreen}
          role="tablist" aria-label="Terminal tabs"
          style={{
            display: 'flex',
            gap: 1,
            background: 'var(--bs-border-faint)',
            flexShrink: 0,
            overflowX: 'auto',
          }}
        >
          <span role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{announcement}</span>
          {tabs.map((t, i) => {
            const activeLeaf = leavesOf(t.root).find(l => l.paneId === t.activePaneId)
            const kind = activeLeaf?.agent ? 'agent' : activeLeaf?.fileNav ? 'files' : 'shell'
            const name = `Terminal tab ${i + 1}: ${kind}`
            const selected = t.id === activeTabId
            return (
              <button
                key={t.id}
                role="tab"
                aria-label={name}
                aria-selected={selected}
                aria-posinset={i + 1}
                aria-setsize={tabs.length}
                draggable
                onClick={() => switchTab(i)}
                onKeyDown={event => {
                  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  const target = i + (event.key === 'ArrowLeft' ? -1 : 1)
                  if (target < 0 || target >= tabs.length) return
                  event.preventDefault()
                  reorderTab(i, target)
                  setAnnouncement(`${name} moved ${event.key === 'ArrowLeft' ? 'before' : 'after'} terminal tab ${target + 1}`)
                }}
                onDragStart={event => {
                  draggedTab.current = t.id
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', t.id)
                }}
                onDragOver={event => {
                  if (draggedTab.current && draggedTab.current !== t.id) {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }
                }}
                onDrop={event => {
                  event.preventDefault()
                  const fromId = draggedTab.current ?? event.dataTransfer.getData('text/plain')
                  const fromIndex = tabs.findIndex(tab => tab.id === fromId)
                  if (fromIndex >= 0 && fromIndex !== i) {
                    reorderTab(fromIndex, i)
                    setAnnouncement(`Terminal tab ${fromIndex + 1} moved ${fromIndex < i ? 'after' : 'before'} terminal tab ${i + 1}`)
                  }
                  draggedTab.current = null
                }}
                onDragEnd={() => { draggedTab.current = null }}
                style={{
                  padding: '2px 10px',
                  fontSize: 10,
                  fontFamily: 'inherit',
                  border: 'none',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  color: selected ? 'var(--bs-fg)' : 'var(--bs-fg-muted)',
                  background: selected ? 'var(--bs-bg-elev)' : 'var(--bs-bg)',
                  boxShadow: selected ? 'inset 0 -1px 0 var(--bs-blue)' : undefined,
                }}
              >
                {i + 1} · {kind}
              </button>
            )
          })}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>{renderNode(tab.root, ctx)}</div>
    </div>
  )
}

export function killPty(id: number): void {
  invoke('pty_kill', { id }).catch(() => {})
}

export function closeFocusedPane(): void {
  requestDestructiveAction({
    kind: 'pane',
    title: 'Close terminal pane?',
    detail: 'This stops the focused shell or provider session and removes the pane from this workspace.',
    onConfirm: closeFocusedPaneNow,
  })
}

function closeFocusedPaneNow(): void {
  const { killPtyId, killBridgeId } = closeActivePane()
  if (killPtyId !== null) killPty(killPtyId)
  if (killBridgeId) void invoke('claude_kill', { projectId: killBridgeId }).catch(() => {})
}
