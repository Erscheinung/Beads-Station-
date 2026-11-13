// Designer Desk (Code-05b.2): the Shelf. Collect context once (text, a file, a
// markdown note), then type it into whichever agent is running. It works with
// any CLI because it only types into a terminal, and it never presses Enter.

import { useMemo, useState } from 'react'
import { readFile } from '../../lib/fsBridge'
import { hasTerminalSession, pasteIntoTerminalSession } from '../../lib/terminalSessions'
import { activePaneId } from '../../state/termPanes'
import { addShelfItem, classifyInput, composePayload, removeShelfItem, useShelf, type ShelfItem } from './shelf'
import { designerSessionPaneId } from './SessionView'
import { relativeTime } from './transcripts'

const KIND_LABEL: Record<ShelfItem['kind'], string> = { note: 'Text', file: 'File', markdown: 'Note' }

export function ShelfView({ project }: { project: { id: string; name: string; path: string } }) {
  const items = useShelf(project.id)
  const [draft, setDraft] = useState('')
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [targetId, setTargetId] = useState<string>('')
  const [message, setMessage] = useState<string | null>(null)

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

  return <div style={styles.root} data-testid="designer-shelf">
    <header>
      <h2 style={styles.title}>Shelf</h2>
      <p style={styles.meta}>Context for {project.name}. Paste text, drop in a file path or a markdown note path (an Obsidian note works), then type it into any running agent.</p>
    </header>

    <div style={styles.add}>
      <textarea value={draft} onChange={event => setDraft(event.target.value)} aria-label="Add to the shelf" placeholder="Paste text or a path like ~/Documents/notes/plan.md"
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); add() } }} style={styles.textarea} />
      <button style={dim(styles.primary, !draft.trim())} disabled={!draft.trim()} onClick={add}>Add to shelf</button>
    </div>

    {items.length === 0
      ? <p style={styles.meta}>Nothing on the shelf. You can also pin an agent’s answer from History.</p>
      : <>
        <ul style={styles.items}>
          {items.map(item => <li key={item.id} style={styles.item}>
            <input type="checkbox" checked={!skipped.has(item.id)} onChange={() => toggle(item.id)} aria-label={`Include ${item.label}`} />
            <span style={styles.kind}>{KIND_LABEL[item.kind]}</span>
            <span style={styles.label} title={item.kind === 'note' ? item.value : item.value}>{item.label}</span>
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
        </div>
      </>}
    {message && <p role="status" style={styles.meta}>{message}</p>}
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
  item: { display: 'grid', gridTemplateColumns: 'auto 48px minmax(0, 1fr) auto auto', gap: 10, alignItems: 'baseline', padding: '8px 4px', borderBottom: '1px solid var(--bs-border)' },
  kind: { fontSize: 11, fontWeight: 600, color: 'var(--bs-fg-muted)', textTransform: 'uppercase' },
  label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  primary: { padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--bs-orange)', color: '#fff', fontWeight: 600, cursor: 'pointer' },
  quiet: { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg)', cursor: 'pointer' },
  select: { padding: '7px 8px', borderRadius: 8, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg)', font: 'inherit' },
  link: { border: 'none', background: 'transparent', color: 'var(--bs-fg-muted)', cursor: 'pointer', fontSize: 12 },
}
