import { useEffect, useRef, useState } from 'react'
import { useProjects } from '../state/projects'
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

/** Shared first-run and open-workspace flow; discovery never starts processes. */
export function WorkspacePicker({ onClose }: { onClose?: () => void }) {
  const { availableProjects, openIds, roots, warnings, loaded, error, refresh, openFolder, saveRoots } = useProjects()
  const skin = useSkin()
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState('')
  const [rootText, setRootText] = useState(roots.join('\n'))
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  useEffect(() => { setRootText(roots.join('\n')) }, [roots])
  useEffect(() => {
    if (!onClose) return
    const el = dialog.current
    el?.showModal()
    return () => el?.close()
  }, [onClose])

  const run = async (action: () => Promise<void>, dismiss = false) => {
    setBusy(true)
    setActionError(null)
    try { await action(); if (dismiss) onClose?.() }
    catch (e) { setActionError(String(e)) }
    finally { setBusy(false) }
  }
  const explicitPath = isExplicitFolderPath(folder)
  // The prominent entry field is both a path opener and project typeahead. Keep
  // the lower discovery search usable as a separate field when the entry is
  // empty, without ever rescanning or opening a project while typing.
  const projectQuery = explicitPath ? query : folder.trim() || query
  const matches = availableProjects.filter(p => `${p.name} ${p.path}`.toLowerCase().includes(projectQuery.toLowerCase()))
  const bestMatch = !explicitPath ? matches[0] : undefined
  const submit = () => {
    const value = folder.trim()
    if (!value) return
    if (explicitPath) {
      void run(() => openFolder(value), true)
    } else if (bestMatch) {
      void run(() => openFolder(bestMatch.path), true)
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
    <form className="workspace-picker__folder" onSubmit={e => { e.preventDefault(); submit() }}>
      <label className="sr-only" htmlFor="workspace-folder">Folder path</label>
      <input id="workspace-folder" value={folder} onChange={e => {
        const value = e.target.value
        setFolder(value)
        // Mirror project names into the discovery field so the two visible
        // entry points never disagree about which results are shown.
        setQuery(isExplicitFolderPath(value) ? '' : value)
      }} placeholder="Type a project name or ~/Desktop/Code/your-project" autoFocus autoComplete="off" spellCheck={false} />
      <button className="workspace-picker__primary" disabled={busy || !folder.trim() || (!explicitPath && !bestMatch)}>
        {explicitPath ? 'Open folder' : bestMatch ? `Open ${bestMatch.name}` : 'No matching project'} <span className="codicon codicon-arrow-right" aria-hidden />
      </button>
    </form>
    {(actionError || error) && <div className="workspace-picker__error" role="alert"><strong>{actionError ? 'Could not open workspace' : "Couldn't load projects"}</strong><p>{actionError || error}</p><button onClick={() => void run(refresh)} disabled={busy}>Retry discovery</button></div>}
    <div className="workspace-picker__list-header">
      <span>PROJECTS <span className="workspace-picker__count">{availableProjects.length}</span></span>
      <button className="workspace-picker__quiet" disabled={busy} onClick={() => void run(refresh)} aria-label="Refresh projects"><span className="codicon codicon-refresh" aria-hidden /></button>
    </div>
    <label className="workspace-picker__search"><span className="codicon codicon-search" aria-hidden /><input aria-label="Search projects" placeholder="Find a project…" value={query} onChange={e => {
      setQuery(e.target.value)
      if (!isExplicitFolderPath(folder)) setFolder('')
    }} autoComplete="off" /></label>
    <div className="workspace-picker__projects">
      {!loaded ? <p className="workspace-picker__empty" role="status">Finding your projects…</p> : matches.length === 0 ? <p className="workspace-picker__empty">{query ? 'No matching projects.' : 'No projects yet. Open any folder above or add a discovery root below.'}</p> : matches.map(project => <button key={project.id} className="workspace-picker__project" disabled={busy} onClick={() => void run(() => openFolder(project.path), true)}>
        <span className={`codicon codicon-${project.hasGit ? 'repo' : 'folder'}`} aria-hidden />
        <span className="workspace-picker__project-text"><strong>{project.name}</strong><small>{project.path}</small></span>
        {openIds.includes(project.id) && <span className="workspace-picker__open">Open</span>}
        <span className="codicon codicon-chevron-right" aria-hidden />
      </button>)}
    </div>
    <details className="workspace-picker__settings">
      <summary>Discovery roots {warnings.length > 0 && <span className="workspace-picker__warning">· {warnings.length} unavailable</span>}</summary>
      <p>One folder per line. Git projects directly inside these folders appear in the picker.</p>
      <form onSubmit={e => { e.preventDefault(); void run(() => saveRoots(rootText.split('\n').map(s => s.trim()).filter(Boolean))) }}>
        <textarea aria-label="Discovery roots" rows={3} value={rootText} onChange={e => setRootText(e.target.value)} spellCheck={false} />
        <button disabled={busy} className="workspace-picker__primary">Save roots</button>
      </form>
      {warnings.map((warning, i) => <p className="workspace-picker__warning" key={i}>{warning}</p>)}
    </details>
    <footer className="workspace-picker__footer">{skin === 'designer' ? 'Requests, progress and review — in one place.' : 'Your terminal, editor and agents — in one place.'}</footer>
  </div>
  return onClose
    ? <dialog ref={dialog} aria-label="Open workspace" className="workspace-dialog" onCancel={e => { e.preventDefault(); onClose() }}>{content}</dialog>
    : <main className="workspace-welcome">{content}</main>
}
