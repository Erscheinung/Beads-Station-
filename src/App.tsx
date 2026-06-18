import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IssueList } from './components/IssueList'
import { Terminal } from './components/Terminal'
import { ClaudeChat } from './components/ClaudeChat'
import { TabBar } from './components/TabBar'
import { Board } from './components/Board'
import { Statusline } from './components/Statusline'
import { Dashboard } from './components/Dashboard'
import { WhichKey } from './components/WhichKey'
import { MorningConfirm, shouldConfirm, recordConfirmation } from './components/MorningConfirm'
import { useProjects } from './state/projects'
import { useVim } from './state/vim'
import { useVimNav } from './hooks/useVimNav'
import { usePermissionMode, PermissionModePicker } from './state/claudeSettings'

export default function App() {
  useVimNav()
  const vim = useVim()
  const { projects, activeId, setActive, refresh, loaded } = useProjects()
  const active = projects.find(p => p.id === activeId) ?? null
  const [terminalCollapsed, setTerminalCollapsed] = useState(false)
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

  const terminalHeight = terminalCollapsed ? 24 : 280

  // Phase 6 — show MorningConfirm when this project hasn't been confirmed
  // today AND we haven't already confirmed it this session. The session-
  // tracked Set lets a project re-confirm if the user toggles back to it
  // intentionally without re-prompting.
  const needsConfirm = !confirmedFor.has(active.id) && shouldConfirm(active.id)

  const handleResume = () => {
    recordConfirmation(active.id)
    setConfirmedFor(s => {
      const next = new Set(s)
      next.add(active.id)
      return next
    })
  }

  const handleNew = async () => {
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
    setConfirmedFor(s => {
      const next = new Set(s)
      next.add(active.id)
      return next
    })
  }

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
  )
}
