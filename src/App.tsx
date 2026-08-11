import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IssueList } from './components/IssueList'
import { TerminalPanes } from './components/TerminalPanes'
import { setDefaultCwd, spawnAgent, spawnFileNav, useTermPanes, allAgentBridges } from './state/termPanes'
import { ClaudeChat } from './components/ClaudeChat'
import { TabBar } from './components/TabBar'
import { Board } from './components/Board'
import { IssueDetail } from './components/IssueDetail'
import { Statusline } from './components/Statusline'
import { Dashboard } from './components/Dashboard'
import { WhichKey } from './components/WhichKey'
import { DebugOverlay } from './components/DebugOverlay'
import { MorningConfirm, shouldConfirm, recordConfirmation } from './components/MorningConfirm'
import { useProjects } from './state/projects'
import { useVim, setFocused } from './state/vim'
import { useVimNav } from './hooks/useVimNav'
import { usePermissionMode, PermissionModePicker } from './state/claudeSettings'
import { BdLiveProvider } from './lib/BdLiveProvider'
import { DesignerShell } from './components/designer/DesignerShell'

export default function App() {
  useVimNav()
  const vim = useVim()
  const { projects, activeId, setActive, refresh, loaded } = useProjects()
  const active = projects.find(p => p.id === activeId) ?? null
  const [terminalCollapsed, setTerminalCollapsed] = useState(false)
  // Sidebar is collapsible + drag-resizable (was a fixed 320px). Width persists
  // in localStorage; collapse toggles via leader-b. Clamped to a sane range.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('beads-station.sidebarWidth'))
    return saved >= 180 && saved <= 640 ? saved : 320
  })
  // Phase 6 — track which projectId the user has already confirmed THIS day.
  // Persisted state lives in localStorage (see MorningConfirm.tsx); the
  // in-memory copy here is a per-render shortcut so React knows when to
  // unmount the modal and mount ClaudeChat. We initialize lazily based on
  // the persisted today's-YMD on mount.
  const [confirmedFor, setConfirmedFor] = useState<Set<string>>(() => new Set())

  // Phase 6 — pull permissionMode for the active project so we can thread
  // it into ClaudeChat. The hook is called unconditionally with a stable
  // string; when there's no active project we pass a stub id and ignore.
  const permissionApi = usePermissionMode(active?.id ?? '__none__')

  // RV1 — seed the terminal surface's default cwd from the active project.
  // The pane surface is NOT keyed by active.id (persistence: shells survive
  // project switch); setDefaultCwd only affects newly-spawned shells and the
  // very first boot leaf.
  useEffect(() => {
    if (active) setDefaultCwd(active.path)
  }, [active])

  // <leader>p and Shift-Tab / Ctrl-Shift-Tab — cycle projects. Wraps both ways.
  // The custom event carries an optional direction (default +1) so the same
  // handler serves forward (leader-p) and backward (Shift-Tab) cycling. This
  // keeps useVimNav decoupled from project state.
  useEffect(() => {
    const onCycle = (e: Event) => {
      if (projects.length === 0) return
      const dir = (e as CustomEvent<{ dir?: number }>).detail?.dir ?? 1
      const idx = projects.findIndex(p => p.id === activeId)
      const n = projects.length
      const next = projects[((idx + dir) % n + n) % n]
      if (next) setActive(next.id)
    }
    window.addEventListener('project:cycle', onCycle)
    return () => window.removeEventListener('project:cycle', onCycle)
  }, [projects, activeId, setActive])

  // Sidebar collapse toggle (leader-b, dispatched by the vim keymap) + width
  // persistence. Drag-resize is handled inline on the divider (startResize).
  useEffect(() => {
    const onToggle = () => setSidebarCollapsed(c => !c)
    window.addEventListener('sidebar:toggle', onToggle)
    return () => window.removeEventListener('sidebar:toggle', onToggle)
  }, [])

  useEffect(() => {
    localStorage.setItem('beads-station.sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])

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
  const termState = useTermPanes()
  useEffect(() => {
    const t = window.setTimeout(() => {
      invoke('claude_reconcile', { liveBridges: allAgentBridges() }).catch(() => {})
    }, 500)
    return () => window.clearTimeout(t)
  }, [termState])

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
    recordConfirmation(active.id)
    setConfirmedFor(() => new Set(projects.map(p => p.id)))
  }, [active, projects])

  const handleNew = useCallback(async () => {
    if (!active) return
    try {
      await invoke('projects_set_claude_session', {
        id: active.id,
        sessionId: crypto.randomUUID(),
      })
      await refresh()
    } catch (e) {
      console.error('[App] projects_set_claude_session failed', e)
    }
    recordConfirmation(active.id)
    setConfirmedFor(() => new Set(projects.map(p => p.id)))
  }, [active, projects, refresh])

  // DU1 — designer skin: ?ui=designer mounts DesignerShell instead of the
  // terminal shell. All hooks above still run (Rules of Hooks); this check
  // lives after every hook so the hook count is unconditionally stable.
  if (new URLSearchParams(location.search).get('ui') === 'designer') {
    return <DesignerShell />
  }

  if (loaded && projects.length === 0) {
    return <Dashboard />
  }

  if (!active) {
    // First load before projects_list resolves — render Dashboard so the
    // viewport doesn't flicker.
    return <Dashboard />
  }

  const terminalHeight = terminalCollapsed ? 24 : 280

  // Show MorningConfirm at most once per app launch: the first unconfirmed
  // project prompts, and confirming it seeds confirmedFor with every project
  // id (see handleResume/handleNew) so subsequent switches stay silent.
  const needsConfirm = !confirmedFor.has(active.id) && shouldConfirm(active.id)

  return (
    <BdLiveProvider>
    <div className="bs-grid-1px" style={{ display: 'grid', gridTemplateColumns: `${sidebarCollapsed ? 0 : sidebarWidth}px 1fr`, gridTemplateRows: '1fr 280px 22px', height: '100vh' }}>
      <aside style={{ position: 'relative', background: 'var(--bs-bg)', gridRow: '1 / span 2', overflow: 'hidden', display: sidebarCollapsed ? 'none' : 'flex', flexDirection: 'column', boxShadow: vim.focused === 'sidebar' ? 'inset 1px 0 0 var(--bs-blue)' : undefined }}>
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
      <main style={{ background: 'var(--bs-bg)', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <TabBar projects={projects} activeId={activeId} onSelect={setActive} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <Board key={active.id} repoPath={active.path} projectId={active.id} />
          </div>
          <div
            style={{
              height: terminalHeight,
              borderTop: '1px solid var(--bs-border)',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
              transition: 'height 120ms ease',
            }}
          >
            <button
              onClick={() => setTerminalCollapsed(c => !c)}
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
              <span style={{ display: 'inline-block', width: 8, transform: terminalCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 120ms ease' }}>▼</span>
              <span>terminal · {active.path}</span>
            </button>
            {!terminalCollapsed && (
              <div style={{ flex: 1, minHeight: 0 }}>
                <TerminalPanes termFocused={vim.focused === 'terminal'} />
              </div>
            )}
          </div>
        </div>
      </main>
      <section style={{ background: 'var(--bs-bg)', overflow: 'hidden' }}>
        {needsConfirm ? (
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
          />
        )}
      </section>
      <div style={{ gridColumn: '1 / span 2' }}>
        <Statusline repoPath={active.path} projectPath={active.path} />
      </div>
      <WhichKey />
      <IssueDetail repoPath={active.path} />
      {import.meta.env.DEV && <DebugOverlay />}
      {!needsConfirm && <PermissionModePicker projectId={active.id} />}
      {needsConfirm && (
        <MorningConfirm
          projectId={active.id}
          sessionId={active.claudeSessionId}
          onResume={handleResume}
          onNew={handleNew}
        />
      )}
    </div>
    </BdLiveProvider>
  )
}
