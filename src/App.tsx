import { IssueList } from './components/IssueList'
import { Terminal } from './components/Terminal'
import { ClaudeChat } from './components/ClaudeChat'

const REPO = '~/Code/sample-project'

export default function App() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gridTemplateRows: '1fr 280px', height: '100vh', gap: 1, background: 'var(--border)' }}>
      <aside style={{ background: 'var(--bg)', gridRow: '1 / span 2', overflow: 'hidden' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, opacity: 0.7 }}>BEADS STATION · phase 1</div>
        <IssueList repoPath={REPO} />
      </aside>
      <main style={{ background: 'var(--bg)', overflow: 'hidden' }}>
        <Terminal cwd={REPO} />
      </main>
      <section style={{ background: 'var(--bg)' }}>
        <ClaudeChat />
      </section>
    </div>
  )
}
