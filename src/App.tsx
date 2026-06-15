import { IssueList } from './components/IssueList'
import { Terminal } from './components/Terminal'
import { ClaudeChat } from './components/ClaudeChat'
import { TabBar } from './components/TabBar'
import { useProjects } from './state/projects'

export default function App() {
  const { projects, activeId, setActive, loaded } = useProjects()
  const active = projects.find(p => p.id === activeId) ?? null

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

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gridTemplateRows: '1fr 280px', height: '100vh', gap: 1, background: 'var(--border)' }}>
      <aside style={{ background: 'var(--bg)', gridRow: '1 / span 2', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, opacity: 0.7 }}>BEADS STATION · phase 2</div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <IssueList key={active.id} repoPath={active.path} />
        </div>
      </aside>
      <main style={{ background: 'var(--bg)', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <TabBar projects={projects} activeId={activeId} onSelect={setActive} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <Terminal key={active.id} cwd={active.path} />
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
