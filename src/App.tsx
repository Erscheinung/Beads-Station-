import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IssueList } from './components/IssueList'
import { TerminalPanes } from './components/TerminalPanes'
import { setActiveProject, spawnAgent, spawnFileNav, useTermPanesSignature, allAgentBridges, splitActive, focusPaneDirection } from './state/termPanes'
import { ClaudeChat } from './components/ClaudeChat'
import { TabBar } from './components/TabBar'
import { Board } from './components/Board'
import { IssueDetail } from './components/IssueDetail'
import { Statusline } from './components/Statusline'
import { WorkspacePicker } from './components/WorkspacePicker'
import { WhichKey } from './components/WhichKey'
import { DebugOverlay } from './components/DebugOverlay'
import { MorningConfirm } from './components/MorningConfirm'
import { CommandPalette } from './components/CommandPalette'
import { useProjects } from './state/projects'
import { useVim, setFocused } from './state/vim'
import { useSkin, setSkin } from './state/skin'
import { useVimNav } from './hooks/useVimNav'
import { usePermissionMode, PermissionModePicker } from './state/claudeSettings'
import { BdLiveProvider } from './lib/BdLiveProvider'
import { DesignerShell } from './components/designer/DesignerShell'
import { openPalette } from './state/palette'
import { openSettings } from './state/settings'
import { useCommandBindings, shortcutLabel } from './state/commands'
import { setBeadsView, setUiPreferences, useUiPreferences, type BeadsView } from './state/uiPreferences'
import { clearObservedClaudeSession, observedClaudeSession, useSessionPreferences } from './state/sessionPreferences'
import { providerAvailability, providerLabel, useInteractiveChatProvider, useNativeProviderAvailability, type InteractiveChatProvider } from './state/chatProviders'
import { reorderWorkspace, useWorkspaceOrder } from './state/workspaceOrder'
import { dispatchSemanticCommand, getRecipeRuntimeContext, setRecipeRuntimeContext, useRecipeRecording } from './state/recipeIntegration'
import { requestDestructiveAction } from './state/destructiveActions'
import { DestructiveActionGuard } from './components/DestructiveActionGuard'

// Code-mkv — per-project terminal strip height. Falls back to the legacy global
// key, then 280. Clamped to the same 80..700 range the drag/hotkeys enforce.
const TERM_H_MIN = 80
const TERM_H_MAX = 700
const TERM_H_DEFAULT = 280
function loadTerminalHeight(projectId: string | undefined): number {
  const clamp = (n: number) => (n >= TERM_H_MIN && n <= TERM_H_MAX ? n : null)
  try {
    if (projectId) {
      const per = clamp(Number(localStorage.getItem(`beads-station.terminalHeight.${projectId}`)))
      if (per != null) return per
    }
    const global = clamp(Number(localStorage.getItem('beads-station.terminalHeight')))
    if (global != null) return global
  } catch {
    /* non-browser */
  }
  return TERM_H_DEFAULT
}

export default function App() {
  useVimNav()
  const vim = useVim()
  const skin = useSkin()
  const { projects, activeId, setActive, closeProject } = useProjects()
  const workspaceIds = projects.map(project => project.id)
  const persistedWorkspaceOrder = useWorkspaceOrder(workspaceIds)
  const orderedProjects = persistedWorkspaceOrder
    .map(id => projects.find(project => project.id === id))
    .filter((project): project is typeof projects[number] => project != null)
  const active = projects.find(p => p.id === activeId) ?? null
  const [pickerOpen, setPickerOpen] = useState(false)
  const closePicker = useCallback(() => setPickerOpen(false), [])
  const [requestedChats, setRequestedChats] = useState<Map<string, InteractiveChatProvider>>(() => new Map())
  const uiPrefs = useUiPreferences()
  const commandBindings = useCommandBindings()
  const [terminalCollapsed, setTerminalCollapsed] = useState(false)
  // Code-qqt (RV1-focus) — fullscreen terminal focus. When true, the terminal
  // region covers the whole content area (Board stays mounted underneath, so no
  // shell respawn). Toggled by Cmd/Ctrl+Shift+Enter via the `terminal:focus-toggle`
  // event. Not persisted: it's a transient working mode, not a saved layout.
  // Fullscreen terminal focus is never a launch state. Older builds persisted
  // this flag and could reopen with Neovim covering the entire application.
  const [terminalFocus, setTerminalFocus] = useState(false)
  // Fullscreen is a transient presentation mode. Keep the pre-focus layout
  // locally so the exit chord returns to the exact collapsed/focus state the
  // user left, instead of assuming the board was focused and the strip was
  // expanded.
  const terminalFocusRestore = useRef<{ collapsed: boolean; focused: typeof vim.focused } | null>(null)
  useEffect(() => {
    // Remove the legacy persisted value as part of the migration.
    try {
      const raw = localStorage.getItem('beads-station.ui-preferences')
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if ('terminalFocus' in parsed) {
          delete parsed.terminalFocus
          localStorage.setItem('beads-station.ui-preferences', JSON.stringify(parsed))
        }
      }
    } catch { /* storage is optional */ }
  }, [])
  // Code-mkv — strip height is now PER-PROJECT. The old global key
  // `beads-station.terminalHeight` is the fallback/default source; per-project
  // values live under `...terminalHeight.<projectId>`. Seeded from the global
  // key on first load, then reloaded on every project switch (effect below).
  const [terminalHeight, setTerminalHeight] = useState<number>(() => {
    const saved = Number(localStorage.getItem('beads-station.terminalHeight'))
    return saved >= 80 && saved <= 700 ? saved : 280
  })
  const [terminalHeightOwner, setTerminalHeightOwner] = useState<string | undefined>(undefined)
  // Sidebar is collapsible + drag-resizable (was a fixed 320px). Width persists
  // in localStorage; collapse toggles via leader-b. Clamped to a sane range.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(uiPrefs.sidebarCollapsed)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('beads-station.sidebarWidth'))
    return saved >= 180 && saved <= 640 ? saved : 320
  })

  useEffect(() => {
    setSidebarCollapsed(uiPrefs.sidebarCollapsed)
  }, [uiPrefs.sidebarCollapsed])
  // A resume choice applies to this explicit start request only. It is not a
  // calendar acknowledgement shared across unrelated workspaces.
  const [resumeApprovedFor, setResumeApprovedFor] = useState<Set<string>>(() => new Set())
  const sessionPrefs = useSessionPreferences()
  const interactiveChatProvider = useInteractiveChatProvider()
  const providerStatuses = useNativeProviderAvailability()
  const recipeRecording = useRecipeRecording()

  // Phase 6 — pull permissionMode for the active project so we can thread
  // it into ClaudeChat. The hook is called unconditionally with a stable
  // string; when there's no active project we pass a stub id and ignore.
  const permissionApi = usePermissionMode(active?.id ?? '__none__')

  // Code-x8p — the pane surface is now keyed by project. On every active-project
  // change, swap the whole pane/tab/split surface to that project's own tree
  // (lazily created on first visit; the pristine boot surface is adopted for the
  // first project). A project's shells + agent panes are its own and survive a
  // round-trip switch, instead of the old single global tree that showed one
  // project's shells under another project's tab.
  useEffect(() => {
    if (active) setActiveProject(active.id, active.path)
  }, [active])

  // Recipe commands use this one semantic boundary for both manual actions and
  // replay. The listener only receives typed app commands; terminal keystrokes
  // and provider output never enter the recipe system.
  useEffect(() => {
    const onSemanticCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ commandId?: string; args?: Record<string, unknown> }>).detail
      if (!detail?.commandId || !detail.args) return
      switch (detail.commandId) {
        case 'workspace.select':
        case 'workspace.open': {
          const workspaceId = detail.args.workspaceId
          if (typeof workspaceId === 'string' && projects.some(project => project.id === workspaceId)) {
            setActive(workspaceId)
            // Keep recipe replay's synchronous context boundary aligned with
            // the project-surface switch before React effects run.
            setRecipeRuntimeContext({ ...getRecipeRuntimeContext(), workspaceId }, workspaceIds)
          }
          return
        }
        case 'terminal.split': {
          const direction = detail.args.direction
          if (direction !== 'right' && direction !== 'down') return
          setSkin('terminal')
          splitActive(direction === 'right' ? 'h' : 'v')
          setFocused('terminal')
          return
        }
        case 'terminal.focus': {
          const direction = detail.args.direction
          if (direction !== 'left' && direction !== 'right' && direction !== 'up' && direction !== 'down') return
          setSkin('terminal')
          setFocused('terminal')
          focusPaneDirection(direction)
          return
        }
        case 'view.show': {
          const view = detail.args.view
          if (view === 'board' || view === 'explorer' || view === 'terminal-only' || view === 'both') setBeadsView(view)
          return
        }
      }
    }
    window.addEventListener('bs:semantic-command', onSemanticCommand)
    return () => window.removeEventListener('bs:semantic-command', onSemanticCommand)
  }, [projects, setActive])

  useEffect(() => {
    setRecipeRuntimeContext({
      workspaceId: active?.id ?? null,
      terminalId: active ? 'active' : null,
      view: uiPrefs.view === 'board' || uiPrefs.view === 'both' ? 'board' : 'terminal',
      fullscreen: terminalFocus,
    }, workspaceIds)
  }, [active?.id, terminalFocus, uiPrefs.view, workspaceIds.join('|')])

  // <leader>p and Shift-Tab / Ctrl-Shift-Tab — cycle projects. Wraps both ways.
  // The custom event carries an optional direction (default +1) so the same
  // handler serves forward (leader-p) and backward (Shift-Tab) cycling. This
  // keeps useVimNav decoupled from project state.
  useEffect(() => {
    const onCycle = (e: Event) => {
      if (orderedProjects.length === 0) { setPickerOpen(true); return }
      const dir = (e as CustomEvent<{ dir?: number }>).detail?.dir ?? 1
      const idx = orderedProjects.findIndex(p => p.id === activeId)
      const n = orderedProjects.length
      const next = orderedProjects[((idx + dir) % n + n) % n]
      if (next) setActive(next.id)
    }
    window.addEventListener('project:cycle', onCycle)
    return () => window.removeEventListener('project:cycle', onCycle)
  }, [orderedProjects, activeId, setActive])

  // A6 — workspace next/previous/direct-select/reorder commands are routed as
  // semantic events so the command palette and configurable keymap share one
  // implementation. Reordering changes only tab order; project IDs and pane
  // surfaces remain untouched.
  useEffect(() => {
    const onCommand = (e: Event) => {
      const detail = (e as CustomEvent<{ action?: string; index?: number }>).detail ?? {}
      const action = detail.action
      if (!action) return
      if (action === 'next' || action === 'previous') {
        if (orderedProjects.length === 0) { setPickerOpen(true); return }
        const direction = action === 'next' ? 1 : -1
        const index = orderedProjects.findIndex(project => project.id === activeId)
        const next = orderedProjects[((index + direction) % orderedProjects.length + orderedProjects.length) % orderedProjects.length]
        if (next) setActive(next.id)
        return
      }
      if (action === 'select' && typeof detail.index === 'number') {
        const target = orderedProjects[detail.index]
        if (target) setActive(target.id)
        return
      }
      if ((action === 'move-left' || action === 'move-right') && activeId) {
        const index = orderedProjects.findIndex(project => project.id === activeId)
        const target = orderedProjects[index + (action === 'move-left' ? -1 : 1)]
        if (target) reorderWorkspace(activeId, target.id)
      }
    }
    window.addEventListener('workspace:navigate', onCommand)
    return () => window.removeEventListener('workspace:navigate', onCommand)
  }, [orderedProjects, activeId, setActive])

  useEffect(() => {
    const onOpen = () => setPickerOpen(true)
    window.addEventListener('workspace:open', onOpen)
    return () => window.removeEventListener('workspace:open', onOpen)
  }, [])

  // Sidebar collapse toggle (leader-b, dispatched by the vim keymap) + width
  // persistence. Drag-resize is handled inline on the divider (startResize).
  useEffect(() => {
    const onToggle = () => setSidebarCollapsed(c => { const next = !c; setUiPreferences({ sidebarCollapsed: next }); return next })
    window.addEventListener('sidebar:toggle', onToggle)
    return () => window.removeEventListener('sidebar:toggle', onToggle)
  }, [])

  // Code-qqt (RV1-focus) — Cmd/Ctrl+Shift+Enter toggles fullscreen terminal focus.
  // Entering focus also un-collapses the strip and moves vim focus to the
  // terminal so it's usable immediately; leaving restores the prior layout.
  useEffect(() => {
    const onToggle = () => {
      setTerminalFocus(f => {
        const next = !f
        // Focus mode is intentionally transient; never persist it.
        if (next) {
          terminalFocusRestore.current = { collapsed: terminalCollapsed, focused: vim.focused }
          setTerminalCollapsed(false)
          setFocused('terminal')
        } else {
          const restore = terminalFocusRestore.current
          setTerminalCollapsed(restore?.collapsed ?? false)
          setFocused(restore?.focused ?? 'board')
          terminalFocusRestore.current = null
        }
        return next
      })
    }
    window.addEventListener('terminal:focus-toggle', onToggle)
    return () => window.removeEventListener('terminal:focus-toggle', onToggle)
  }, [terminalCollapsed, vim.focused])

  // C-w +/-/=/_  hotkeys dispatch terminal:resize {delta} from useVimNav.
  useEffect(() => {
    const STEP = 40
    const DEFAULT_H = 280
    const onResize = (e: Event) => {
      const delta = (e as CustomEvent<{ delta: number | 'reset' | 'max' }>).detail?.delta
      if (delta === 'reset') { setTerminalHeight(DEFAULT_H); return }
      if (delta === 'max') { setTerminalHeight(700); return }
      if (typeof delta === 'number') {
        setTerminalHeight(h => Math.min(700, Math.max(80, h + delta * STEP)))
      }
    }
    window.addEventListener('terminal:resize', onResize)
    return () => window.removeEventListener('terminal:resize', onResize)
  }, [])

  useEffect(() => {
    localStorage.setItem('beads-station.sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])

  // Code-mkv — on project switch, load that project's persisted strip height.
  useEffect(() => {
    setTerminalHeightOwner(active?.id)
    setTerminalHeight(loadTerminalHeight(active?.id))
  }, [active?.id])

  // Persist the strip height under the active project's key (Code-mkv). Also
  // mirror to the legacy global key so a fresh project inherits a sane default.
  useEffect(() => {
    if (!active?.id || terminalHeightOwner !== active.id) return
    localStorage.setItem(`beads-station.terminalHeight.${active.id}`, String(terminalHeight))
    localStorage.setItem('beads-station.terminalHeight', String(terminalHeight))
  }, [terminalHeight, active?.id, terminalHeightOwner])

  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(640, Math.max(180, startW + (ev.clientX - startX)))
      setSidebarWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  const startTerminalResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = terminalHeight
    // Code-mkv — soft snap: content-area height drives the 25%/50% candidates.
    // Measured once at drag start from <main> (the terminal's container).
    const contentH = (e.currentTarget as HTMLElement).closest('main')?.clientHeight ?? window.innerHeight
    const SNAP_PX = 24
    let last = startH
    const onMove = (ev: MouseEvent) => {
      // Dragging up (negative delta) grows the terminal.
      last = Math.min(700, Math.max(80, startH - (ev.clientY - startY)))
      setTerminalHeight(last)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // Snap to 25% / 50% of the content area when released within SNAP_PX.
      // Fullscreen stays the Cmd/Ctrl+Shift+Enter path, not a drag target.
      for (const frac of [0.25, 0.5]) {
        const cand = Math.min(700, Math.max(80, Math.round(contentH * frac)))
        if (Math.abs(last - cand) <= SNAP_PX) {
          setTerminalHeight(cand)
          break
        }
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [terminalHeight])

  // RV2 — <leader>a spawns a new agent pane on the active project. useVimNav
  // dispatches 'agent:spawn' (decoupled from project state); we resolve the
  // active project here, mint a fresh session id, and focus the terminal
  // surface in insert mode so typing lands in the new pane's input at once.
  useEffect(() => {
    const onSpawn = () => {
      if (!active) return
      spawnAgent(active.id, active.path, crypto.randomUUID(), permissionApi.mode)
      setFocused('terminal')
      // Do NOT setInsert(true) here — the pane's input doesn't exist in the DOM
      // yet, so a synchronous focus lands nowhere (the "stuck typing" bug). The
      // ClaudeChat mount autofocuses its input via rAF, which fires onFocus ->
      // setInsert(true), tying insert mode to real focus.
    }
    window.addEventListener('agent:spawn', onSpawn)
    return () => window.removeEventListener('agent:spawn', onSpawn)
  }, [active, permissionApi.mode])

  // RV3-B — <leader>e spawns a file-nav pane on the active project. Same
  // decoupled-event pattern as agent:spawn; the FileTree focuses its own root
  // on becoming active, so no synchronous focus dance is needed here.
  useEffect(() => {
    const onFileNav = () => {
      if (!active) return
      spawnFileNav(active.path)
      setFocused('terminal')
    }
    window.addEventListener('filenav:spawn', onFileNav)
    return () => window.removeEventListener('filenav:spawn', onFileNav)
  }, [active])

  // RV3.7 (Code-uu5) — reconcile backend claude sessions against the live pane
  // tree. Agent panes are persistent (unmount does NOT claude_kill), and a tab
  // reset can drop an agent leaf without routing through closeActivePane, which
  // would otherwise leak its claude child until app exit. On every pane-tree
  // change (debounced) we send the set of still-live agent bridges; the backend
  // reaps any session not in that set. useTermPanes() re-renders on each
  // mutation so this effect re-runs; the debounce coalesces bursts.
  // Code-aod — subscribe only to the reconcile-slice SIGNATURE (joined agent
  // bridges + active tab), not the whole pane state. Pure focus/insert churn
  // leaves the signature unchanged, so it no longer re-renders App (and its
  // whole tree). The effect body reads allAgentBridges() directly.
  const termSig = useTermPanesSignature()
  useEffect(() => {
    const t = window.setTimeout(() => {
      // Code-raa: include the legacy bottom-chat bridge (== active project id)
      // so reconcile never reaps it. allAgentBridges() only covers agent panes.
      const agentBridges = allAgentBridges()
      const legacyBridge = active?.id
      const liveBridges = legacyBridge
        ? [...agentBridges, legacyBridge]
        : agentBridges
      invoke('claude_reconcile', { liveBridges }).catch(() => {})
    }, 500)
    return () => window.clearTimeout(t)
  }, [termSig, active])

  // Memoized so their identity is stable across renders. Declared BEFORE the
  // early returns below (Rules of Hooks — a useCallback after a conditional
  // return throws "Rendered more hooks than during the previous render"). They
  // null-guard `active` internally since it can be null on early-return paths.
  //
  // Stable identity is also what fixed the R3.5 render-loop regression: a fresh
  // handleResume each render re-ran MorningConfirm's [onResume] effect, which
  // re-asserted button focus, which bubbled to Statusline's window 'focus'
  // listener → bd_counts → setState → re-render → new handleResume → … Maximum
  // update depth.
  const handleResume = useCallback(() => {
    if (!active) return
    setResumeApprovedFor(previous => new Set(previous).add(active.id))
  }, [active])

  const handleNew = useCallback(() => {
    if (!active) return
    clearObservedClaudeSession(active.id)
    setResumeApprovedFor(previous => new Set(previous).add(active.id))
  }, [active])

  const handleCancelStart = useCallback(() => {
    if (!active) return
    setRequestedChats(previous => {
      const next = new Map(previous)
      next.delete(active.id)
      return next
    })
  }, [active])

  // DU1 / Code-6if — designer skin mounts DesignerShell instead of the terminal
  // shell. The skin now lives in a runtime store (seeded from the ?ui=designer
  // param on first run) so an in-app control can flip it live. This check lives
  // after every hook so the hook count is unconditionally stable.
  if (!active) {
    // Keep a concrete recovery surface visible for the whole discovery gap.
    // Native WebViews can paint the previous explorer frame before the async
    // project snapshot arrives; rendering an empty shell during that gap looks
    // like the app disappeared and leaves no way to recover from a stale
    // workspace selection.
    return (
      <BdLiveProvider>
        <WorkspacePicker />
        <CommandPalette repoPath="" />
        <DestructiveActionGuard />
      </BdLiveProvider>
    )
  }

  if (skin === 'designer') {
    return <BdLiveProvider><DesignerShell /><CommandPalette repoPath={active.path} /><IssueDetail repoPath={active.path} /><DestructiveActionGuard />{pickerOpen && <WorkspacePicker onClose={closePicker} />}</BdLiveProvider>
  }

  const activeTerminalHeight = terminalCollapsed ? 24 : terminalHeight

  const chatRequested = requestedChats.has(active.id)
  // Store the provider chosen at the explicit start action. Changing the
  // setting while a chat is alive must not remount it into another backend.
  const activeChatProvider = requestedChats.get(active.id) ?? interactiveChatProvider
  const selectedProviderStatus = providerAvailability(providerStatuses, interactiveChatProvider)
  const chatProviderUnavailable = selectedProviderStatus?.available === false
  const resumableSession = activeChatProvider === 'claude' ? observedClaudeSession(active.id) : null
  const needsConfirm = chatRequested
    && activeChatProvider === 'claude'
    && sessionPrefs.askBeforeResume
    && resumableSession !== null
    && !resumeApprovedFor.has(active.id)

  const showExplorer = uiPrefs.view === 'explorer' || uiPrefs.view === 'both'
  const showBoard = uiPrefs.view === 'board' || uiPrefs.view === 'both'
  const switchView = (view: BeadsView) => {
    const semanticView = view === 'terminal-only' || view === 'explorer' || view === 'board' || view === 'both' ? view : 'terminal-only'
    dispatchSemanticCommand('view.show', { view: semanticView }, { kind: 'view', view: semanticView === 'terminal-only' ? 'terminal' : semanticView === 'explorer' ? 'files' : 'board' })
  }
  const selectWorkspace = (id: string) => {
    dispatchSemanticCommand('workspace.select', { workspaceId: id }, { kind: 'workspace', workspaceId: id })
  }

  return (
    <BdLiveProvider>
    <div
      className={`bs-grid-1px${terminalFocus ? ' bs-app--terminal-focus' : ''}`}
      data-terminal-app-focus={terminalFocus ? 'true' : 'false'}
      style={{ display: 'grid', gridTemplateColumns: `${showExplorer && !sidebarCollapsed ? sidebarWidth : 0}px 1fr`, gridTemplateRows: `1fr ${chatRequested ? activeTerminalHeight : 0}px 22px`, height: '100vh' }}
    >
      <aside style={{ position: 'relative', background: 'var(--bs-bg)', gridColumn: 1, gridRow: '1 / span 2', overflow: 'hidden', display: showExplorer && !sidebarCollapsed ? 'flex' : 'none', flexDirection: 'column', boxShadow: vim.focused === 'sidebar' ? 'inset 1px 0 0 var(--bs-blue)' : undefined }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <IssueList key={active.id} repoPath={active.path} />
        </div>
        {/* Drag handle on the sidebar's right edge (leader-b toggles collapse). */}
        <div
          onMouseDown={startSidebarResize}
          title="Drag to resize sidebar"
          style={{ position: 'absolute', top: 0, right: 0, width: 4, height: '100%', cursor: 'col-resize', zIndex: 5 }}
        />
      </aside>
      <main style={{ background: 'var(--bs-bg)', gridColumn: 2, gridRow: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <header className="bs-toolbar bs-app-chrome">
          <span className="bs-toolbar__brand">BEADS STATION</span>
          <button onClick={openPalette} title="Open command palette">Commands <kbd>{shortcutLabel(commandBindings.palette)}</kbd></button>
          {recipeRecording.status === 'recording' && <button aria-label="Recipe recording active; open recipe settings to stop" onClick={() => { openSettings(); window.dispatchEvent(new Event('recipes:open')) }} title="Recipe recording is active">● Recording · {recipeRecording.stepCount}</button>}
          <button onClick={() => setSkin('designer')}>Designer</button>
          <label className="bs-toolbar__select">View
            <select aria-label="Beads view" value={uiPrefs.view} onChange={e => switchView(e.target.value as BeadsView)}>
              <option value="terminal-only">Terminal only</option><option value="explorer">Explorer</option><option value="board">Board</option><option value="both">Both</option>
            </select>
          </label>
          {(!showExplorer || sidebarCollapsed) && (
            <button onClick={() => setUiPreferences({ view: 'explorer', sidebarCollapsed: false })} title="Show the Explorer sidebar">
              Show Explorer
            </button>
          )}
          <button
            disabled={chatRequested || chatProviderUnavailable}
            title={chatProviderUnavailable ? `${providerLabel(interactiveChatProvider)} is unavailable` : undefined}
            onClick={() => setRequestedChats(prev => {
              if (prev.has(active.id)) return prev
              const next = new Map(prev)
              next.set(active.id, interactiveChatProvider)
              return next
            })}
          >{chatRequested ? `${providerLabel(activeChatProvider)} chat running` : `Start ${providerLabel(interactiveChatProvider)} chat`}</button>
          <button onClick={openSettings} title="Open settings">Settings <kbd>{shortcutLabel(commandBindings.settings)}</kbd></button>
        </header>
        <div className="bs-app-chrome">
          <TabBar projects={orderedProjects} activeId={activeId} onSelect={selectWorkspace} onReorder={reorderWorkspace} onOpen={() => setPickerOpen(true)} onClose={id => {
            const project = projects.find(candidate => candidate.id === id)
            if (!project) return
            requestDestructiveAction({
              kind: 'workspace',
              title: `Close ${project.name}?`,
              detail: 'This closes the workspace tab and stops its terminal and provider sessions.',
              onConfirm: async () => {
                setRequestedChats(prev => { const next = new Map(prev); next.delete(id); return next })
                await closeProject(id)
              },
            })
          }} />
        </div>
        <div className="bs-terminal-content" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {/* Board stays MOUNTED under the fullscreen terminal (no remount /
              no shell respawn); we only hide it visually while focused. */}
          <div style={{ flex: 1, minHeight: 0, display: showBoard ? 'block' : 'none', ...(terminalFocus ? { visibility: 'hidden' as const } : null) }}>
            <Board key={active.id} repoPath={active.path} projectId={active.id} projectName={active.name} />
          </div>
          <div
            className="bs-terminal-region"
            data-terminal-focus={terminalFocus ? 'true' : 'false'}
            style={{
              height: terminalFocus || !showBoard ? undefined : activeTerminalHeight,
              borderTop: '1px solid var(--bs-border)',
              position: terminalFocus ? 'absolute' : 'relative',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
              flex: !showBoard && !terminalFocus ? 1 : undefined,
              transition: terminalFocus ? undefined : 'height 120ms ease',
              // RV1-focus: cover the whole content area, Board mounted beneath.
              ...(terminalFocus
                ? { inset: 0, zIndex: 10, background: 'var(--bs-bg)' }
                : null),
            }}
          >
            {/* Drag handle on the terminal's top border — mirrors sidebar
                resize. Hidden in fullscreen focus (height is not user-dragged). */}
            {showBoard && !terminalCollapsed && !terminalFocus && (
              <div
                onMouseDown={startTerminalResize}
                title="Drag to resize terminal (C-w +/- to step)"
                style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, cursor: 'row-resize', zIndex: 5 }}
              />
            )}
            <button
              onClick={() => (terminalFocus
                ? window.dispatchEvent(new CustomEvent('terminal:focus-toggle'))
                : setTerminalCollapsed(c => !c))}
              title={terminalFocus ? 'Exit fullscreen (Cmd/Ctrl+Shift+Enter)' : 'Fullscreen: Cmd/Ctrl+Shift+Enter'}
              style={{
                height: 24,
                padding: '0 10px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                color: 'var(--bs-fg)',
                opacity: 0.7,
                background: 'var(--bs-bg-elev)',
                border: 'none',
                borderBottom: '1px solid var(--bs-border)',
                fontFamily: 'inherit',
                cursor: 'pointer',
                textAlign: 'left',
                flexShrink: 0,
              }}
            >
              <span style={{ display: 'inline-block', width: 8, transform: terminalCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 120ms ease' }}>
                {terminalFocus ? '⤢' : '▼'}
              </span>
              <span>terminal · {active.path}{terminalFocus ? '  ·  fullscreen (Cmd/Ctrl+Shift+Enter to exit)' : ''}</span>
            </button>
            {!terminalCollapsed && (
              <div style={{ flex: 1, minHeight: 0 }}>
                <TerminalPanes termFocused={vim.focused === 'terminal'} fullscreen={terminalFocus} />
              </div>
            )}
          </div>
        </div>
      </main>
      <section style={{ background: 'var(--bs-bg)', gridColumn: 2, gridRow: 2, overflow: 'hidden' }}>
        {chatRequested && (needsConfirm ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--bs-fg-muted)', fontSize: 11 }}>
            awaiting confirmation
          </div>
        ) : (
          <ClaudeChat
            key={active.id}
            projectId={active.id}
            cwd={active.path}
            sessionId={active.claudeSessionId}
            permissionMode={permissionApi.mode}
            provider={activeChatProvider}
          />
        ))}
      </section>
      <div className="bs-app-statusline" style={{ gridColumn: '1 / span 2', gridRow: 3 }}>
        <Statusline repoPath={active.path} projectPath={active.path} />
      </div>
      <WhichKey />
      <IssueDetail repoPath={active.path} />
      <CommandPalette repoPath={active.path} />
      <DestructiveActionGuard />
      {pickerOpen && <WorkspacePicker onClose={closePicker} />}
      {import.meta.env.DEV && <DebugOverlay />}
      {chatRequested && !needsConfirm && activeChatProvider === 'claude' && <PermissionModePicker projectId={active.id} />}
      {needsConfirm && (
        <MorningConfirm
          projectName={active.name}
          sessionId={resumableSession!}
          onResume={handleResume}
          onNew={handleNew}
          onCancel={handleCancelStart}
        />
        )}
    </div>
    </BdLiveProvider>
  )
}
