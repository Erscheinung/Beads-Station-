import { useCallback, useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { usePalette, closePalette, openPalette } from '../state/palette'
import { useProjects } from '../state/projects'
import { useBdSnapshot } from '../lib/bdCache'
import { bdClaim, bdCreate } from '../types/issue'
import { COMMANDS, useCommandBindings, shortcutLabel, type CommandId } from '../state/commands'
import { openSettings } from '../state/settings'
import { SettingsPanel } from './SettingsPanel'
import { toggleTheme, setThemePalette, useThemePaletteId, BUNDLED_THEMES } from '../state/theme'
import { setSkin } from '../state/skin'
import { setBeadsView, setUiPreferences, type BeadsView } from '../state/uiPreferences'
import { closeFocusedPane } from './TerminalPanes'
import { toggleNotificationPanel } from '../state/notificationPanel'
import { stepTerminalFontSize } from '../state/terminalAppearance'
import { spawnBrowser, newTab, unsplitToTabs, toggleZoom, resizePane, cycleTab, switchTab, moveActiveTab, typeIntoActiveShell, joinTabs, restoreSplit, launchInTerminalPane } from '../state/termPanes'
import { agentLaunchCommand } from '../state/sessionPreferences'
import { initializeBeads } from '../lib/beadsInit'
import { setFocused } from '../state/vim'
import { dispatchSemanticCommand } from '../state/recipeIntegration'
import { clearAllPaneNotifications, jumpToLatestPaneNotification } from '../state/paneNotifications'
import { checkForUpdates } from '../state/appUpdate'
import './CommandPalette.css'

// Phase 9 (Code-ky4.9) — cmdk command palette. Opens on Cmd/Ctrl+K or leader-k
// (see useVimNav). Six commands: switch project, new issue, claim ready, grep
// issues, open Obsidian update, toggle theme.
//
// Code-6wx: added "Choose theme" sub-view listing bundled themes by name.
//
// cmdk's <Command.Dialog> owns the overlay + portal + a11y + fuzzy filtering;
// we style it with the app's --bs-* tokens (dark, no purple). The palette lives
// in the primary shell only (not the ?ui=designer skin) and needs the active
// repo, so App mounts it inside the shell where `active` is known.

type View = 'root' | 'projects' | 'ready' | 'grep' | 'newIssue' | 'themes' | 'layout'

export function CommandPalette({ repoPath }: { repoPath: string }) {
  const { open } = usePalette()
  const { projects, activeId, refresh } = useProjects()
  const snap = useBdSnapshot(repoPath)
  const activePaletteId = useThemePaletteId()
  const bindings = useCommandBindings()

  const [view, updateView] = useState<View>('root')
  const [search, setSearch] = useState('')
  const setView = (next: View) => { updateView(next); setSearch('') }
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  // Reset the sub-view + inputs whenever the dialog opens or closes so it never
  // reopens mid-flow.
  const onOpenChange = useCallback((next: boolean) => {
    if (!next) {
      closePalette()
      setView('root')
      setTitle('')
    }
  }, [])

  const dismiss = useCallback(() => {
    closePalette()
    setView('root')
    setTitle('')
  }, [])

  const onSwitchProject = useCallback((id: string) => {
    dispatchSemanticCommand('workspace.select', { workspaceId: id }, { kind: 'workspace', workspaceId: id })
    dismiss()
  }, [dismiss])

  const onClaim = useCallback(async (id: string) => {
    setBusy(true)
    try {
      await bdClaim(repoPath, id)
    } finally {
      setBusy(false)
      dismiss()
    }
  }, [repoPath, dismiss])

  const onGrepOpen = useCallback((id: string) => {
    window.dispatchEvent(new CustomEvent('issue:open', { detail: { id, repoPath } }))
    dismiss()
  }, [repoPath, dismiss])

  const onNewIssue = useCallback(async () => {
    const t = title.trim()
    if (!t) return
    setBusy(true)
    try {
      await bdCreate(repoPath, t)
      await refresh()
    } finally {
      setBusy(false)
      dismiss()
    }
  }, [repoPath, title, refresh, dismiss])

  const onToggleTheme = useCallback(() => {
    toggleTheme()
    dismiss()
  }, [dismiss])

  const onChooseTheme = useCallback((id: string) => {
    setThemePalette(id)
    dismiss()
  }, [dismiss])

  const onSwitchToDesigner = useCallback(() => {
    setSkin('designer')
    dismiss()
  }, [dismiss])

  const onAction = useCallback((event: string) => {
    setSkin('terminal')
    window.dispatchEvent(new Event(event))
    dismiss()
  }, [dismiss])

  const execute = (id: CommandId) => {
    const command = COMMANDS.find(c => c.id === id)
    if (!command || ('repo' in command && command.repo && !repoPath)) return
    if (['projects', 'newIssue', 'ready', 'grep', 'themes', 'layout'].includes(id)) {
      setView(id as View); openPalette(); return
    }
    dismiss()
    if (id === 'initializeBeads') {
      void initializeBeads(repoPath).catch(() => {})
      return
    }
    if (id === 'workspacePrevious' || id === 'workspaceNext') {
      window.dispatchEvent(new CustomEvent('workspace:navigate', { detail: { action: id === 'workspaceNext' ? 'next' : 'previous' } }))
      return
    }
    if (id === 'workspaceMoveLeft' || id === 'workspaceMoveRight') {
      window.dispatchEvent(new CustomEvent('workspace:navigate', { detail: { action: id === 'workspaceMoveLeft' ? 'move-left' : 'move-right' } }))
      return
    }
    if (id.startsWith('workspaceSelect')) {
      const index = Number(id.slice('workspaceSelect'.length)) - 1
      window.dispatchEvent(new CustomEvent('workspace:navigate', { detail: { action: 'select', index } }))
      return
    }
    if (id === 'terminalPrevious' || id === 'terminalNext') {
      setSkin('terminal')
      cycleTab(id === 'terminalNext' ? 1 : -1)
      setFocused('terminal')
      typeIntoActiveShell()
      return
    }
    if (id === 'terminalMoveLeft' || id === 'terminalMoveRight') {
      setSkin('terminal')
      moveActiveTab(id === 'terminalMoveLeft' ? -1 : 1)
      setFocused('terminal')
      return
    }
    if (id.startsWith('terminalSelect')) {
      setSkin('terminal')
      switchTab(Number(id.slice('terminalSelect'.length)) - 1)
      setFocused('terminal')
      typeIntoActiveShell()
      return
    }
    switch (id) {
      case 'palette': openPalette(); break
      case 'settings': openSettings(); break
      case 'workspace': window.dispatchEvent(new Event('workspace:open')); break
      case 'toggleTheme': onToggleTheme(); break
      case 'designer': onSwitchToDesigner(); break
      case 'terminal': setSkin('terminal'); break
      case 'newTab': setSkin('terminal'); newTab(); setFocused('terminal'); typeIntoActiveShell(); break
      case 'splitH': dispatchSemanticCommand('terminal.split', { direction: 'right' }, { kind: 'active-terminal' }); break
      case 'splitV': dispatchSemanticCommand('terminal.split', { direction: 'down' }, { kind: 'active-terminal' }); break
      case 'unsplit': setSkin('terminal'); unsplitToTabs(); break
      case 'restoreSplit': setSkin('terminal'); if (restoreSplit()) { setFocused('terminal'); typeIntoActiveShell() } break
      case 'joinTabs': setSkin('terminal'); joinTabs(); setFocused('terminal'); typeIntoActiveShell(); break
      case 'launchClaude': setSkin('terminal'); launchInTerminalPane(agentLaunchCommand('claude')); setFocused('terminal'); typeIntoActiveShell(); break
      case 'launchCodex': setSkin('terminal'); launchInTerminalPane(agentLaunchCommand('codex')); setFocused('terminal'); typeIntoActiveShell(); break
      case 'chatPanel': setSkin('terminal'); window.dispatchEvent(new Event('chat:open-panel')); break
      case 'closeWorkspace': window.dispatchEvent(new CustomEvent('workspace:navigate', { detail: { action: 'close' } })); break
      case 'closePane': setSkin('terminal'); closeFocusedPane(); break
      case 'zoomPane': setSkin('terminal'); toggleZoom(); break
      case 'fullscreen': setSkin('terminal'); window.dispatchEvent(new CustomEvent('terminal:focus-toggle')); break
      case 'focusLeft': dispatchSemanticCommand('terminal.focus', { direction: 'left' }, { kind: 'active-terminal' }); break
      case 'focusRight': dispatchSemanticCommand('terminal.focus', { direction: 'right' }, { kind: 'active-terminal' }); break
      case 'focusUp': dispatchSemanticCommand('terminal.focus', { direction: 'up' }, { kind: 'active-terminal' }); break
      case 'focusDown': dispatchSemanticCommand('terminal.focus', { direction: 'down' }, { kind: 'active-terminal' }); break
      case 'resizeLeft': setSkin('terminal'); setFocused('terminal'); resizePane('left'); break
      case 'resizeRight': setSkin('terminal'); setFocused('terminal'); resizePane('right'); break
      case 'resizeUp': setSkin('terminal'); setFocused('terminal'); resizePane('up'); break
      case 'resizeDown': setSkin('terminal'); setFocused('terminal'); resizePane('down'); break
      case 'terminalFontLarger': stepTerminalFontSize(1); break
      case 'terminalFontSmaller': stepTerminalFontSize(-1); break
      case 'terminalFontReset': stepTerminalFontSize(null); break
      case 'notificationJump': jumpToLatestPaneNotification(); break
      case 'notificationPanel': toggleNotificationPanel(); break
      case 'notificationsClear': clearAllPaneNotifications(); break
      case 'checkForUpdates': openSettings(); window.dispatchEvent(new Event('settings:show-about')); void checkForUpdates(); break
      case 'agent': onAction('agent:spawn'); break
      case 'files': onAction('filenav:spawn'); break
      case 'browser': setSkin('terminal'); spawnBrowser(''); setFocused('terminal'); break
      case 'expand': case 'collapse': window.dispatchEvent(new CustomEvent('sidebar:cmd', { detail: { cmd: id === 'expand' ? 'expandAll' : 'collapseAll' } })); break
      case 'hideExplorer': setUiPreferences({ sidebarCollapsed: true }); break
      case 'showBoard': dispatchSemanticCommand('view.show', { view: 'board' }, { kind: 'view', view: 'board' }); break
    }
  }
  useEffect(() => {
    const handler = (e: Event) => execute((e as CustomEvent<CommandId>).detail)
    window.addEventListener('bs:command', handler)
    return () => window.removeEventListener('bs:command', handler)
  })

  return (
    <>
    <SettingsPanel />
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      className="bs-palette"
      contentClassName="bs-palette-content"
      overlayClassName="bs-palette-overlay"
    >
      {view === 'newIssue' ? (
        <>
          <Command.Input
            value={title}
            onValueChange={setTitle}
            placeholder="New issue title…"
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void onNewIssue()
              }
            }}
          />
          <Command.List>
            <Command.Item disabled={busy} onSelect={() => void onNewIssue()}>
              {busy ? 'Creating…' : `Create task: "${title.trim() || '…'}"`}
            </Command.Item>
            <Command.Item onSelect={() => setView('root')}>Cancel</Command.Item>
          </Command.List>
        </>
      ) : (
        <>
          <Command.Input value={search} onValueChange={setSearch} placeholder="Type a command or search issues…" autoFocus />
          <Command.List>
            <Command.Empty>No results.</Command.Empty>

            {view === 'root' && (
              <Command.Group heading="Commands">
                {COMMANDS.filter(c => c.id !== 'palette').map(c => (
                  <Command.Item key={c.id} value={c.label} disabled={'repo' in c && c.repo && !repoPath} onSelect={() => execute(c.id)}>
                    <span>{c.label}</span><kbd>{bindings[c.id] ? shortcutLabel(bindings[c.id]) : '—'}</kbd>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {view === 'projects' && (
              <Command.Group heading="Switch project">
                {projects.map(p => (
                  <Command.Item
                    key={p.id}
                    value={`${p.name} ${p.id}`}
                    onSelect={() => onSwitchProject(p.id)}
                  >
                    {p.name}
                    {p.id === activeId ? ' · active' : ''}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {view === 'ready' && (
              <Command.Group heading="Claim ready">
                {snap.ready.length === 0 && <Command.Item disabled>No ready issues.</Command.Item>}
                {snap.ready.map(i => (
                  <Command.Item
                    key={i.id}
                    value={`${i.id} ${i.title}`}
                    disabled={busy}
                    onSelect={() => void onClaim(i.id)}
                  >
                    {i.id} · {i.title}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {view === 'grep' && (
              <Command.Group heading="Search beads / issue explorer">
                {snap.all.map(i => (
                  <Command.Item
                    key={i.id}
                    value={`${i.id} ${i.title}`}
                    onSelect={() => onGrepOpen(i.id)}
                  >
                    {i.id} · {i.title}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {view === 'themes' && (
              <Command.Group heading="Choose theme">
                {BUNDLED_THEMES.map(t => (
                  <Command.Item
                    key={t.name}
                    value={t.name}
                    onSelect={() => onChooseTheme(t.name)}
                  >
                    {t.name}{t.name === activePaletteId ? ' · active' : ''}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {view === 'layout' && (
              <Command.Group heading="View settings">
                {(['terminal-only', 'explorer', 'board', 'both'] as BeadsView[]).map(id => (
                  <Command.Item key={id} onSelect={() => { setBeadsView(id); dismiss() }}>
                    {id === 'terminal-only' ? 'Terminal only' : id[0].toUpperCase() + id.slice(1)}
                  </Command.Item>
                ))}
                <Command.Item onSelect={() => { window.dispatchEvent(new Event('sidebar:toggle')); dismiss() }}>Toggle explorer collapse</Command.Item>
              </Command.Group>
            )}
          </Command.List>
        </>
      )}
    </Command.Dialog>
    </>
  )
}
