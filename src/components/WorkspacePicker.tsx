import { useEffect, useRef, useState } from 'react'
import {
  browseForFolder,
  cancelFolderDiscovery,
  discoverUnderFolder,
  type Project,
  useProjects, cloneRepository } from '../state/projects'
import { setSkin, useSkin } from '../state/skin'
import './WorkspacePicker.css'

/** A path-shaped entry is always an explicit open request, never a project query. */
export function isExplicitFolderPath(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '.'
    || trimmed === '..'
    || trimmed === '~'
    || trimmed.startsWith('/')
    || trimmed.startsWith('~/')
    || trimmed.startsWith('./')
    || trimmed.startsWith('../')
    || trimmed.includes('/')
}

function normalized(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase()
}

/** Small in-process matcher; it deliberately needs no fzf/rg in a packaged app. */
export function fuzzyScore(query: string, candidate: string): number {
  const needle = normalized(query)
  const haystack = normalized(candidate)
  if (!needle) return 0
  if (haystack === needle) return 1_000
  if (haystack.startsWith(needle)) return 800 - Math.min(needle.length, 100)
  const contiguous = haystack.indexOf(needle)
  if (contiguous >= 0) return 600 - Math.min(contiguous, 100)
  let cursor = 0
  let gaps = 0
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor)
    if (found < 0) return -1
    gaps += found - cursor
    cursor = found + 1
  }
  return 300 - Math.min(gaps, 250) - Math.min(haystack.length - needle.length, 100) / 100
}

/** Rank exact/prefix/fuzzy matches, then explicit recent opens, then path. */
export function rankProjects(projects: Project[], query: string, recentIds: string[]): Project[] {
  const recency = new Map(recentIds.map((id, index) => [id, index]))
  const needle = normalized(query)
  return projects
    .map((project, originalIndex) => {
      const nameScore = fuzzyScore(needle, project.name)
      const pathScore = fuzzyScore(needle, project.path)
      const score = needle ? Math.max(nameScore, pathScore) : 0
      return { project, originalIndex, score, recent: recency.get(project.id) ?? Number.MAX_SAFE_INTEGER }
    })
    .filter(item => !needle || item.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.recent !== b.recent) return a.recent - b.recent
      if (a.project.name.toLocaleLowerCase() !== b.project.name.toLocaleLowerCase()) {
        return a.project.name.toLocaleLowerCase().localeCompare(b.project.name.toLocaleLowerCase())
      }
      return a.project.path.localeCompare(b.project.path) || a.originalIndex - b.originalIndex
    })
    .map(item => item.project)
}

type PickerScope = 'known' | 'under-folder'

function projectActionLabel(project: Project): string {
  // Include the canonical path in the accessible name even for unique names:
  // it makes the action unambiguous in VoiceOver and in automation, while the
  // visible row remains compact.
  return `Open ${project.name} — ${project.path}`
}

/** Shared first-run and open-workspace flow; discovery never starts processes. */
export function WorkspacePicker({ onClose }: { onClose?: () => void }) {
  const {
    availableProjects,
    openIds,
    recentIds: storedRecentIds,
    roots,
    warnings,
    loaded,
    error,
    refresh,
    openFolder,
    saveRoots,
  } = useProjects()
  const skin = useSkin()
  const dialog = useRef<HTMLDialogElement>(null)
  const requestSequence = useRef(0)
  const activeRequest = useRef<string | null>(null)
  const [entry, setEntry] = useState('')
  const [cloneUrl, setCloneUrl] = useState('')
  const [scope, setScope] = useState<PickerScope>('known')
  const [scopeRoot, setScopeRoot] = useState(roots[0] ?? '')
  const [scopeProjects, setScopeProjects] = useState<Project[]>([])
  const [scopeWarnings, setScopeWarnings] = useState<string[]>([])
  const [scopeTruncated, setScopeTruncated] = useState(false)
  const [scopeBusy, setScopeBusy] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [localRecentIds, setLocalRecentIds] = useState<string[]>([])
  const [rootText, setRootText] = useState(roots.join('\n'))
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => { setRootText(roots.join('\n')) }, [roots])
  useEffect(() => {
    if (!scopeRoot && roots[0]) setScopeRoot(roots[0])
  }, [roots, scopeRoot])
  useEffect(() => {
    if (!onClose) return
    const el = dialog.current
    el?.showModal()
    return () => { el?.close() }
  }, [onClose])

  useEffect(() => {
    if (scope !== 'under-folder' || !scopeRoot.trim()) {
      if (activeRequest.current) void cancelFolderDiscovery(activeRequest.current).catch(() => {})
      activeRequest.current = null
      setScopeProjects([])
      setScopeWarnings([])
      setScopeTruncated(false)
      setScopeBusy(false)
      return
    }
    const sequence = ++requestSequence.current
    const requestId = `workspace-picker-${sequence}`
    activeRequest.current = requestId
    setScopeBusy(true)
    setScopeWarnings([])
    void discoverUnderFolder(scopeRoot.trim(), requestId).then(result => {
      if (sequence !== requestSequence.current) return
      setScopeProjects(result.projects)
      setScopeWarnings(result.warnings)
      setScopeTruncated(result.truncated)
    }).catch(error => {
      if (sequence !== requestSequence.current) return
      setScopeProjects([])
      setScopeWarnings([String(error)])
      setScopeTruncated(false)
    }).finally(() => {
      if (sequence === requestSequence.current) {
        activeRequest.current = null
        setScopeBusy(false)
      }
    })
    return () => {
      if (activeRequest.current === requestId) void cancelFolderDiscovery(requestId).catch(() => {})
    }
  }, [scope, scopeRoot])

  const run = async (action: () => Promise<void>, dismiss = false) => {
    setBusy(true)
    setActionError(null)
    try { await action(); if (dismiss) onClose?.() }
    catch (e) { setActionError(String(e)) }
    finally { setBusy(false) }
  }

  const explicitPath = isExplicitFolderPath(entry)
  const recentIds = localRecentIds.length > 0 ? localRecentIds : (storedRecentIds ?? [])
  const sourceProjects = scope === 'known' ? availableProjects : scopeProjects
  const matches = rankProjects(sourceProjects, explicitPath ? '' : entry, recentIds)
  const selectedProject = !explicitPath ? matches[highlightedIndex] : undefined

  useEffect(() => {
    setHighlightedIndex(index => Math.min(index, Math.max(0, matches.length - 1)))
  }, [entry, scope, scopeProjects.length, availableProjects.length])

  const rememberLocalOpen = (project: Project) => {
    setLocalRecentIds(ids => [project.id, ...ids.filter(id => id !== project.id)].slice(0, 20))
  }
  const openProject = (project: Project) => {
    rememberLocalOpen(project)
    void run(() => openFolder(project.path), true)
  }
  const submit = () => {
    const value = entry.trim()
    if (explicitPath) {
      void run(() => openFolder(value), true)
    } else if (selectedProject) {
      openProject(selectedProject)
    }
  }
  const browseWorkspace = () => void run(async () => {
    const path = await browseForFolder()
    if (path) {
      setScope('known')
      setEntry(path)
      setHighlightedIndex(0)
      // Finder's Load/Open result is already an explicit user choice. Open it
      // immediately instead of requiring a second click on the picker action.
      await openFolder(path)
      onClose?.()
    }
  })
  const browseScope = () => void run(async () => {
    const path = await browseForFolder()
    if (path) {
      setScopeRoot(path)
      setScope('under-folder')
      setEntry('')
      setHighlightedIndex(0)
    }
  })
  const onEntryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && matches.length > 0) {
      event.preventDefault()
      setHighlightedIndex(index => (index + 1) % matches.length)
    } else if (event.key === 'ArrowUp' && matches.length > 0) {
      event.preventDefault()
      setHighlightedIndex(index => (index - 1 + matches.length) % matches.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }
  const content = <div className="workspace-picker" data-testid={skin === 'designer' ? 'designer-empty-state' : 'workspace-picker'}>
    <header className="workspace-picker__header">
      <span className="workspace-picker__brand"><span className="codicon codicon-terminal" aria-hidden /> Beads Station</span>
      {onClose ? <button aria-label="Dismiss workspace picker" onClick={onClose} className="workspace-picker__quiet">Esc <span className="codicon codicon-close" aria-hidden /></button>
        : <button className="workspace-picker__quiet" onClick={() => setSkin(skin === 'designer' ? 'terminal' : 'designer')}>{skin === 'designer' ? 'Developer workspace' : 'Designer workspace'} <span className="codicon codicon-arrow-right" aria-hidden /></button>}
    </header>
    <h1>{onClose ? 'Open a workspace' : 'Your work starts here.'}</h1>
    <p className="workspace-picker__intro">Choose a project or open a folder. Only the workspaces you open are restored.</p>
    <form className="workspace-picker__folder" onSubmit={event => { event.preventDefault(); submit() }}>
      <label className="workspace-picker__entry-label" htmlFor="workspace-folder">Find a workspace or enter a path</label>
      <div className="workspace-picker__entry-row">
        <input
          id="workspace-folder"
          role="combobox"
          aria-label="Find a workspace or enter a path"
          aria-controls="workspace-results"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={selectedProject ? `workspace-result-${selectedProject.id}` : undefined}
          value={entry}
          onChange={event => { setEntry(event.target.value); setHighlightedIndex(0) }}
          onKeyDown={onEntryKeyDown}
          placeholder="Project name, path, or ~/Desktop/Code/project"
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" className="workspace-picker__browse" onClick={browseWorkspace} disabled={busy} aria-label="Browse for a workspace folder">
          <span className="codicon codicon-folder-opened" aria-hidden /> Browse
        </button>
      </div>
      <button className="workspace-picker__primary" disabled={busy || !entry.trim() || (!explicitPath && !selectedProject)}>
        {explicitPath ? 'Open folder' : selectedProject ? `Open ${selectedProject.name}` : 'No matching project'} <span className="codicon codicon-arrow-right" aria-hidden />
      </button>
    </form>
    {(actionError || error) && <div className="workspace-picker__error" role="alert"><strong>{actionError ? 'Could not open workspace' : "Couldn't load projects"}</strong><p>{actionError || error}</p><button onClick={() => void run(refresh)} disabled={busy}>Retry discovery</button></div>}
    <div className="workspace-picker__scope-row">
      <div className="workspace-picker__scope" role="tablist" aria-label="Workspace search scope">
        <button type="button" role="tab" aria-selected={scope === 'known'} className={scope === 'known' ? 'is-selected' : ''} onClick={() => { setScope('known'); setEntry(''); setHighlightedIndex(0) }}>Known projects</button>
        <button type="button" role="tab" aria-selected={scope === 'under-folder'} className={scope === 'under-folder' ? 'is-selected' : ''} onClick={() => { setScope('under-folder'); setEntry(''); setHighlightedIndex(0) }}>Under folder</button>
      </div>
      <span className="workspace-picker__count">{sourceProjects.length}{scope === 'under-folder' && scopeTruncated ? '+' : ''}</span>
    </div>
    {scope === 'under-folder' && <div className="workspace-picker__under-folder">
      <span className="codicon codicon-folder" aria-hidden />
      <span title={scopeRoot}>{scopeRoot || 'Choose a folder to search'}</span>
      <button type="button" className="workspace-picker__quiet" onClick={browseScope} disabled={busy || scopeBusy}>Change folder</button>
    </div>}
    <div id="workspace-results" className="workspace-picker__projects" role="listbox" aria-label={scope === 'known' ? 'Known projects' : 'Projects under folder'}>
      {!loaded ? <p className="workspace-picker__empty" role="status">Finding your projects…</p>
        : scopeBusy ? <p className="workspace-picker__empty" role="status">Indexing folders…</p>
          : matches.length === 0 ? <p className="workspace-picker__empty">{entry && !explicitPath ? 'No matching projects.' : scope === 'under-folder' && scopeWarnings.length === 0 ? 'No folders found in this scope.' : 'No projects yet. Open any folder above or add a discovery root below.'}</p>
            : matches.map((project, index) => <button
              type="button"
              key={project.id}
              id={`workspace-result-${project.id}`}
              role="option"
              aria-selected={index === highlightedIndex}
              aria-label={projectActionLabel(project)}
              className={`workspace-picker__project ${index === highlightedIndex ? 'is-highlighted' : ''}`}
              disabled={busy}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => openProject(project)}
            >
              <span className={`codicon codicon-${project.hasGit ? 'repo' : 'folder'}`} aria-hidden />
              <span className="workspace-picker__project-text"><strong>{project.name}</strong><small>{project.path}</small></span>
              {openIds.includes(project.id) && <span className="workspace-picker__open">Open</span>}
              <span className="codicon codicon-chevron-right" aria-hidden />
            </button>)}
    </div>
    {scope === 'under-folder' && (scopeWarnings.length > 0 || scopeTruncated) && <div className="workspace-picker__scope-note" role="status">
      {scopeTruncated && <span>Showing the first 500 folders.</span>}
      {scopeWarnings.map((warning, index) => <span key={index}>{warning}</span>)}
    </div>}
    <details className="workspace-picker__settings workspace-picker__clone">
      <summary>Clone a repository</summary>
      <p>Clones into {roots[0] ?? '~/Desktop/Code'} and opens it. Uses your own git login.</p>
      <form onSubmit={event => { event.preventDefault(); if (cloneUrl.trim()) void run(() => cloneRepository(cloneUrl.trim(), roots[0] ?? '~/Desktop/Code'), true) }}>
        <input aria-label="Repository address" value={cloneUrl} onChange={event => setCloneUrl(event.target.value)} placeholder="https://github.com/owner/repo.git" spellCheck={false} autoComplete="off" />
        <button disabled={busy || !cloneUrl.trim()} className="workspace-picker__primary">Clone</button>
      </form>
    </details>
    <details className="workspace-picker__settings">
      <summary>Discovery roots {warnings.length > 0 && <span className="workspace-picker__warning">· {warnings.length} unavailable</span>}</summary>
      <p>Known projects are cached from these folders. Under folder is a bounded, ignore-aware search and never opens workspaces while indexing.</p>
      <form onSubmit={event => { event.preventDefault(); void run(() => saveRoots(rootText.split('\n').map(value => value.trim()).filter(Boolean))) }}>
        <textarea aria-label="Discovery roots" rows={3} value={rootText} onChange={event => setRootText(event.target.value)} spellCheck={false} />
        <button disabled={busy} className="workspace-picker__primary">Save roots</button>
      </form>
      {warnings.map((warning, index) => <p className="workspace-picker__warning" key={index}>{warning}</p>)}
    </details>
    <footer className="workspace-picker__footer">{skin === 'designer' ? 'Requests, progress and review — in one place.' : 'Your terminal, editor and agents — in one place.'}</footer>
  </div>
  return onClose
    ? <dialog ref={dialog} aria-label="Open workspace" className="workspace-dialog" onCancel={event => { event.preventDefault(); onClose() }}>{content}</dialog>
    : <main className="workspace-welcome">{content}</main>
}
