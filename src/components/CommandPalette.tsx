import { useCallback, useState } from 'react'
import { Command } from 'cmdk'
import { usePalette, closePalette } from '../state/palette'
import { useProjects } from '../state/projects'
import { useBdSnapshot } from '../lib/bdCache'
import { bdClaim, bdCreate } from '../types/issue'
import { dailyAppend } from '../lib/dailyBridge'
import { toggleTheme, setThemePalette, useThemePaletteId, BUNDLED_THEMES } from '../state/theme'
import { setSkin } from '../state/skin'
import { setBeadsView, setUiPreferences, type BeadsView } from '../state/uiPreferences'
import { newTab, splitActive } from '../state/termPanes'
import { setFocused } from '../state/vim'
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
  const { projects, activeId, setActive, refresh } = useProjects()
  const snap = useBdSnapshot(repoPath)
  const activePaletteId = useThemePaletteId()

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
    setActive(id)
    dismiss()
  }, [setActive, dismiss])

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

  const onOpenObsidian = useCallback(async () => {
    setBusy(true)
    try {
      // Minimal v1: append a titled placeholder subsection (opens/creates
      // today's daily file). A richer body editor is a later polish item.
      await dailyAppend('Manual note', '')
    } finally {
      setBusy(false)
      dismiss()
    }
  }, [dismiss])

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

  return (
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
                <Command.Item onSelect={() => { dismiss(); window.dispatchEvent(new Event('workspace:open')) }}>Open workspace</Command.Item>
                <Command.Item onSelect={() => setView('projects')}>Switch project</Command.Item>
                <Command.Item disabled={!repoPath} onSelect={() => setView('newIssue')}>New issue</Command.Item>
                <Command.Item disabled={!repoPath} onSelect={() => setView('ready')}>Claim ready</Command.Item>
                <Command.Item disabled={!repoPath} keywords={['grep']} onSelect={() => setView('grep')}>Search beads / issue explorer</Command.Item>
                <Command.Item onSelect={() => void onOpenObsidian()}>Open Obsidian update</Command.Item>
                <Command.Item onSelect={onToggleTheme}>Toggle theme</Command.Item>
                <Command.Item onSelect={() => setView('themes')}>Choose theme</Command.Item>
                <Command.Item onSelect={() => setView('layout')}>View settings</Command.Item>
                <Command.Item onSelect={onSwitchToDesigner}>Switch to designer skin</Command.Item>
                <Command.Item onSelect={() => { setSkin('terminal'); dismiss() }}>Switch to terminal skin</Command.Item>
                <Command.Item disabled={!repoPath} onSelect={() => { setSkin('terminal'); newTab(); setFocused('terminal'); dismiss() }}>New terminal tab</Command.Item>
                <Command.Item disabled={!repoPath} onSelect={() => { setSkin('terminal'); splitActive('h'); setFocused('terminal'); dismiss() }}>Split terminal horizontally</Command.Item>
                <Command.Item disabled={!repoPath} onSelect={() => { setSkin('terminal'); splitActive('v'); setFocused('terminal'); dismiss() }}>Split terminal vertically</Command.Item>
                <Command.Item disabled={!repoPath} onSelect={() => onAction('agent:spawn')}>New Claude agent pane</Command.Item>
                <Command.Item disabled={!repoPath} onSelect={() => onAction('filenav:spawn')}>Open files explorer</Command.Item>
                <Command.Item onSelect={() => { window.dispatchEvent(new CustomEvent('sidebar:cmd', { detail: { cmd: 'expandAll' } })); dismiss() }}>Expand all beads</Command.Item>
                <Command.Item onSelect={() => { window.dispatchEvent(new CustomEvent('sidebar:cmd', { detail: { cmd: 'collapseAll' } })); dismiss() }}>Collapse bead groups</Command.Item>
                <Command.Item onSelect={() => { setUiPreferences({ sidebarCollapsed: true }); dismiss() }}>Collapse explorer</Command.Item>
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
  )
}
