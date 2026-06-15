import { useState } from 'react'
import { IssueList } from './components/IssueList'
import { Terminal } from './components/Terminal'
import { ClaudeChat } from './components/ClaudeChat'
import { TabBar } from './components/TabBar'
import { Board } from './components/Board'
import { useProjects } from './state/projects'

export default function App() {
  const { projects, activeId, setActive, loaded } = useProjects()
  const active = projects.find(p => p.id === activeId) ?? null
  const [terminalCollapsed, setTerminalCollapsed] = useState(false)

  if (loaded && projects.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--fg)', opacity: 0.6, fontSize: 13 }}>
        No projects under ~/Code/
      </div>
    )
  }

  if (!active) {
    // First load before projects_list resolves — render the chrome so the
    // viewport doesn't flicker.
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--fg)', opacity: 0.4, fontSize: 12 }}>
        loading projects…
      </div>
    )
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
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gridTemplateRows: '1fr 280px', height: '100vh', gap: 1, background: 'var(--border)' }}>
      <aside style={{ background: 'var(--bg)', gridRow: '1 / span 2', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, opacity: 0.7 }}>BEADS · ALL READY</div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <IssueList key={active.id} repoPath={active.path} />
        </div>
      </aside>
      <main style={{ background: 'var(--bg)', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <TabBar projects={projects} activeId={activeId} onSelect={setActive} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <Board key={active.id} repoPath={active.path} projectId={active.id} />
          </div>
          <div
            style={{
              height: terminalHeight,
              borderTop: '1px solid var(--border)',
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
                color: 'var(--fg)',
                opacity: 0.7,
                background: 'var(--bg-elev)',
                border: 'none',
                borderBottom: '1px solid var(--border)',
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
      <section style={{ background: 'var(--bg)', overflow: 'hidden' }}>
        <ClaudeChat
          key={active.id}
          projectId={active.id}
          cwd={active.path}
          sessionId={active.claudeSessionId}
        />
      </section>
    </div>
  )
}
