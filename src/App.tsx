import { useEffect, useState } from 'react'
import { IssueList } from './components/IssueList'
import { Terminal } from './components/Terminal'
import { ClaudeChat } from './components/ClaudeChat'
import { TabBar } from './components/TabBar'
import { Board } from './components/Board'
import { Statusline } from './components/Statusline'
import { Dashboard } from './components/Dashboard'
import { WhichKey } from './components/WhichKey'
import { useProjects } from './state/projects'
import { useVim } from './state/vim'
import { useVimNav } from './hooks/useVimNav'

export default function App() {
  useVimNav()
  const vim = useVim()
  const { projects, activeId, setActive, loaded } = useProjects()
  const active = projects.find(p => p.id === activeId) ?? null
  const [terminalCollapsed, setTerminalCollapsed] = useState(false)

  // <leader>p — cycle to the next project. Wraps at end. The custom
  // event is dispatched by the global vim keymap; this keeps
  // useVimNav decoupled from project state.
  useEffect(() => {
    const onCycle = () => {
      if (projects.length === 0) return
      const idx = projects.findIndex(p => p.id === activeId)
      const next = projects[(idx + 1) % projects.length]
      if (next) setActive(next.id)
    }
    window.addEventListener('project:cycle', onCycle)
    return () => window.removeEventListener('project:cycle', onCycle)
  }, [projects, activeId, setActive])

  if (loaded && projects.length === 0) {
    return <Dashboard />
  }

  if (!active) {
    // First load before projects_list resolves — render Dashboard so the
    // viewport doesn't flicker.
    return <Dashboard />
  }

  // Layout strategy (Phase 3):
  //   Sidebar (320px, full height) — IssueList ALL READY.
  //   Main pane top — TabBar.
  //   Main pane center — Board (1fr).
  //   Main pane bottom — Terminal (280px, collapsible).
  //   Bottom strip (full width) — ClaudeChat.
  //
  // We keep the existing 2-row outer grid. The main cell is now an internal
  // vertical flex: TabBar | Board (1fr) | Terminal (280px or 24px header
  // when collapsed). This keeps Phase-2 chrome and just swaps Terminal-only
  // content for Board+Terminal stack.
  const terminalHeight = terminalCollapsed ? 24 : 280

  return (
    <div className="bs-grid-1px" style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gridTemplateRows: '1fr 280px 22px', height: '100vh' }}>
      <aside style={{ background: 'var(--bs-bg)', gridRow: '1 / span 2', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: vim.focused === 'sidebar' ? 'inset 1px 0 0 var(--bs-blue)' : undefined }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <IssueList key={active.id} repoPath={active.path} />
        </div>
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
                <Terminal key={active.id} cwd={active.path} />
              </div>
            )}
          </div>
        </div>
      </main>
      <section style={{ background: 'var(--bs-bg)', overflow: 'hidden' }}>
        <ClaudeChat
          key={active.id}
          projectId={active.id}
          cwd={active.path}
          sessionId={active.claudeSessionId}
        />
      </section>
      <div style={{ gridColumn: '1 / span 2' }}>
        <Statusline repoPath={active.path} projectPath={active.path} />
      </div>
      <WhichKey />
    </div>
  )
}
