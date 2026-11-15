// Designer Desk (Code-05b.2): Pinned context (called the Shelf in code and in
// older notes). Collect context once (text, a file, a
// markdown note), then type it into whichever agent is running. It works with
// any CLI because it only types into a terminal, and it never presses Enter.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { readFile } from '../../lib/fsBridge'
import { hasTerminalSession, pasteIntoTerminalSession } from '../../lib/terminalSessions'
import { activePaneId } from '../../state/termPanes'
import { addShelfItem, classifyInput, composePayload, dropItems, openAction, removeShelfItem, useShelf, type ShelfItem } from './shelf'
import { VaultSection } from './VaultSection'
import { watchFileDrop } from '../../lib/fileDrop'
import { openInEditor } from '../../lib/openInEditor'
import { useSessionPreferences } from '../../state/sessionPreferences'
import { designerSessionPaneId } from './SessionView'
import { relativeTime } from './transcripts'
import { openDesignerView } from '../../state/designerNav'

const KIND_LABEL: Record<ShelfItem['kind'], string> = { note: 'Text', file: 'File', markdown: 'Note', folder: 'Folder', link: 'Link' }

export function ShelfView({ project }: { project: { id: string; name: string; path: string } }) {
  const items = useShelf(project.id)
  const [draft, setDraft] = useState('')
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [targetId, setTargetId] = useState<string>('')
  const [message, setMessage] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const { obsidianVaultPath } = useSessionPreferences()
  const vault = obsidianVaultPath.trim()

  // Dropped files and folders become references (a path), never copies.
  const pinPaths = useCallback(async (paths: string[]) => {
    const kinds = await invoke<string[]>('pin_kinds', { paths }).catch(() => paths.map(() => 'file'))
    const found = dropItems(paths, kinds)
    found.forEach(item => addShelfItem(project.id, item))
    setMessage(found.length ? `Pinned ${found.length} item${found.length === 1 ? '' : 's'}. Only the path is kept; nothing was copied.` : 'Nothing to pin: those paths no longer exist.')
  }, [project.id])
  useEffect(() => {
    let stop: (() => void) | null = null
    let gone = false
    void watchFileDrop(() => root.current, paths => { void pinPaths(paths) }).then(cleanup => { if (gone) cleanup(); else stop = cleanup }).catch(() => {})
    return () => { gone = true; stop?.() }
  }, [pinPaths])
  // A link dragged in from a browser (and, outside the app, files) arrives as an ordinary drop.
  const onDomDrop = (event: React.DragEvent) => {
    const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
    const parsed = text.split('\n').map(line => classifyInput(line)).filter(item => item && item.kind !== 'note')
    if (parsed.length === 0) return
    event.preventDefault()
    parsed.forEach(item => item && addShelfItem(project.id, item))
    setMessage(`Pinned ${parsed.length} item${parsed.length === 1 ? '' : 's'}.`)
  }

  const open = async (item: ShelfItem) => {
    try {
      const action = openAction(item)
      if (action === 'browser') await openUrl(item.value)
      else if (action === 'editor') await openInEditor({ path: item.value }, { cwd: project.path })
      else if (action === 'system') await invoke('pin_open', { path: item.value })
    } catch (failure) { setMessage(String(failure)) }
  }

  // Offered at render time: a terminal that is not running cannot be typed into.
  const sessionPane = designerSessionPaneId(project.id)
  const targets = [
    { id: sessionPane, label: 'Designer session' },
    { id: activePaneId(), label: 'Active terminal pane' },
  ].filter((target, index, all) => target.id && hasTerminalSession(target.id) && all.findIndex(other => other.id === target.id) === index)
  const target = targets.find(candidate => candidate.id === targetId) ?? targets[0] ?? null

  const chosen = useMemo(() => items.filter(item => !skipped.has(item.id)), [items, skipped])
  const toggle = (id: string) => setSkipped(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })

  const add = () => {
    const parsed = classifyInput(draft)
    if (!parsed) return
    addShelfItem(project.id, parsed)
    setDraft('')
    setMessage(null)
  }

  const payload = () => composePayload(chosen, async path => {
    const file = await readFile(path, 64 * 1024)
    return { content: file.content, truncated: file.truncated, binary: file.binary }
  })

  const send = async () => {
    if (!target || chosen.length === 0) return
    const text = await payload()
    setMessage(pasteIntoTerminalSession(target.id, text)
      ? `Typed ${chosen.length} item${chosen.length === 1 ? '' : 's'} into the ${target.label.toLowerCase()}. Nothing was submitted.`
      : `The ${target.label.toLowerCase()} is not running.`)
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(await payload()); setMessage('Copied.') } catch { setMessage('Could not copy.') }
  }

  return <div ref={root} style={styles.root} data-testid="designer-shelf" onDragOver={event => event.preventDefault()} onDrop={onDomDrop}>
    <header>
      <h2 style={styles.title}>Pinned</h2>
      <p style={styles.meta}>Keep the things you reuse in prompts for {project.name}: a paragraph, a file, a folder, a link or a note. Drop a file, folder or link anywhere on this page to pin it: only its location is kept. Double-click an item to open it. One click types them into a running agent’s prompt. It never presses Enter, so you can still edit before sending.</p>
    </header>

    <div style={styles.add}>
      <textarea value={draft} onChange={event => setDraft(event.target.value)} aria-label="Add something to pin" placeholder="Paste text, or a path like ~/Documents/notes/plan.md (Cmd+Enter to pin)"
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); add() } }} style={styles.textarea} />
      <button style={dim(styles.primary, !draft.trim())} disabled={!draft.trim()} onClick={add}>Pin it</button>
    </div>

    {items.length === 0
      ? <div style={styles.empty} data-testid="pinned-empty">
        <strong>Nothing pinned yet.</strong>
        <span>Three ways to fill this:</span>
        <span>1. Paste text or a file path in the box above.</span>
        <span>2. In History, press “Pin” on any answer worth keeping. <button style={styles.inline} onClick={() => openDesignerView('history')}>Open History</button></span>
        <span>3. Drag a file, folder or link onto this page, or paste a path or URL. Markdown notes (an Obsidian note works) are read when you use them.</span>
        <span>{vault ? 'Your Obsidian vault is listed below.' : 'Set an Obsidian vault folder in Settings → Sessions to browse its notes here.'}</span>
      </div>
      : <>
        <ul style={styles.items}>
          {items.map(item => <li key={item.id} style={styles.item} onDoubleClick={() => void open(item)} title={openAction(item) === 'none' ? undefined : 'Double-click to open'}>
            <input type="checkbox" checked={!skipped.has(item.id)} onChange={() => toggle(item.id)} aria-label={`Include ${item.label}`} />
            <span style={styles.kind}>{KIND_LABEL[item.kind]}</span>
            <span style={styles.label} title={item.value}>{item.label}</span>
            <span style={styles.meta}>{item.source ? `${item.source} · ` : ''}{relativeTime(item.addedAt)}</span>
            <button style={styles.link} onClick={() => removeShelfItem(project.id, item.id)} aria-label={`Remove ${item.label}`}>Remove</button>
          </li>)}
        </ul>
        <div style={styles.actions}>
          {targets.length > 1 && <select value={target?.id ?? ''} onChange={event => setTargetId(event.target.value)} aria-label="Send to" style={styles.select}>
            {targets.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
          </select>}
          <button style={dim(styles.primary, !target || chosen.length === 0)} disabled={!target || chosen.length === 0} onClick={() => void send()}
            title={target ? 'Types the text into the terminal without pressing Enter' : 'Start a session or open a terminal first'}>
            {target ? `Type ${chosen.length} into ${target.label.toLowerCase()}` : 'No running session to send to'}
          </button>
          <button style={dim(styles.quiet, chosen.length === 0)} disabled={chosen.length === 0} onClick={() => void copy()}>Copy</button>
          {!target && <button style={styles.quiet} onClick={() => openDesignerView('session')}>Start a session</button>}
        </div>
        <p style={styles.meta}>Ticked items are used. {target ? '' : 'There is no running agent to type into yet: start a Session here, or an agent in the Terminal.'}</p>
      </>}
    {message && <p role="status" style={styles.meta}>{message}</p>}
    {vault && <VaultSection vault={vault} onPin={path => { addShelfItem(project.id, { kind: 'markdown', value: path }); setMessage('Pinned this note.') }} />}
  </div>
}

/** A disabled button must look disabled, not just refuse clicks. */
const dim = (base: React.CSSProperties, off: boolean): React.CSSProperties => off ? { ...base, opacity: 0.45, cursor: 'not-allowed' } : base

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0, padding: 16, boxSizing: 'border-box', overflowY: 'auto' },
  title: { margin: 0, fontSize: 18, fontWeight: 600 },
  meta: { margin: '2px 0 0', fontSize: 12, color: 'var(--bs-fg-muted)' },
  add: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' },
  textarea: { width: '100%', minHeight: 72, padding: 8, borderRadius: 8, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg)', font: 'inherit', resize: 'vertical', boxSizing: 'border-box' },
  items: { listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--bs-border)' },
  item: { display: 'grid', gridTemplateColumns: 'auto 56px minmax(0, 1fr) auto auto', gap: 10, alignItems: 'baseline', padding: '8px 4px', borderBottom: '1px solid var(--bs-border)' },
  kind: { fontSize: 11, fontWeight: 600, color: 'var(--bs-fg-muted)', textTransform: 'uppercase' },
  label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  primary: { padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--bs-orange)', color: '#fff', fontWeight: 600, cursor: 'pointer' },
  quiet: { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg)', cursor: 'pointer' },
  select: { padding: '7px 8px', borderRadius: 8, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg)', font: 'inherit' },
  empty: { display: 'flex', flexDirection: 'column', gap: 6, padding: 16, borderRadius: 10, border: '1px dashed var(--bs-border)', fontSize: 13, color: 'var(--bs-fg-muted)' },
  inline: { border: 'none', background: 'transparent', color: 'var(--bs-orange)', cursor: 'pointer', font: 'inherit', padding: 0, textDecoration: 'underline' },
  link: { border: 'none', background: 'transparent', color: 'var(--bs-fg-muted)', cursor: 'pointer', fontSize: 12 },
}
