// Pinned: the Obsidian vault named in Settings, listed and rendered read-only.
// Reading a note starts nothing; links open in the browser, never in this window.

import { useEffect, useMemo, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { MarkdownText } from '../RenderItems'
import { filterNotes, listVault, notePath, prepareNote, readVaultNote, type VaultNote, type VaultNoteContent } from './vault'
import { relativeTime } from './transcripts'

const SHOWN = 200

export function VaultSection({ vault, onPin }: { vault: string; onPin: (path: string) => void }) {
  const [notes, setNotes] = useState<VaultNote[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState<VaultNoteContent | null>(null)

  useEffect(() => {
    let cancelled = false
    setNotes(null); setSelected(null); setNote(null); setError(null)
    listVault(vault)
      .then(result => { if (!cancelled) { setNotes(result.notes); setTruncated(result.truncated) } })
      .catch(failure => { if (!cancelled) setError(String(failure)) })
    return () => { cancelled = true }
  }, [vault])

  useEffect(() => {
    if (!selected) { setNote(null); return }
    let cancelled = false
    setNote(null)
    readVaultNote(vault, selected)
      .then(result => { if (!cancelled) setNote(result) })
      .catch(failure => { if (!cancelled) setError(String(failure)) })
    return () => { cancelled = true }
  }, [vault, selected])

  const matches = useMemo(() => filterNotes(notes ?? [], query), [notes, query])

  // Links in a note go to the system browser; the app window must never navigate away.
  const onClick = (event: React.MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) return
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^(https?:|mailto:)/i.test(href)) void openUrl(href).catch(() => {})
  }

  return <section style={styles.root} aria-label="Obsidian vault" data-testid="pinned-vault">
    <div style={styles.head}>
      <h3 style={styles.title}>Vault</h3>
      <span style={styles.meta}>{notes ? `${notes.length} note${notes.length === 1 ? '' : 's'}${truncated ? '+' : ''} · read-only` : 'Reading…'}</span>
    </div>
    {error && <p role="alert" style={{ ...styles.meta, color: 'var(--bs-red)' }}>{error}</p>}
    {notes && <>
      <input value={query} onChange={event => setQuery(event.target.value)} aria-label="Search the vault" placeholder="Filter notes by name or folder" style={styles.search} />
      <ul style={styles.list}>
        {matches.slice(0, SHOWN).map(item => <li key={item.rel}>
          <button style={{ ...styles.row, ...(selected === item.rel ? styles.rowActive : null) }} aria-current={selected === item.rel} title={item.rel} onClick={() => setSelected(item.rel)}>
            <span style={styles.name}>{item.name}</span>
            <span style={styles.meta}>{item.rel.includes('/') ? item.rel.slice(0, item.rel.lastIndexOf('/')) : ''}</span>
            <span style={styles.meta}>{relativeTime(item.modifiedMs)}</span>
          </button>
        </li>)}
        {matches.length === 0 && <li style={styles.meta}>{notes.length === 0 ? 'No markdown notes in this folder.' : 'No note matches.'}</li>}
        {matches.length > SHOWN && <li style={styles.meta}>Showing the newest {SHOWN} of {matches.length}. Type to narrow it down.</li>}
      </ul>
    </>}
    {selected && <article className="bs-vault-note" style={styles.note} data-testid="vault-note" onClick={onClick}>
      <div style={styles.head}>
        <strong style={styles.name}>{selected}</strong>
        <button style={styles.link} onClick={() => onPin(notePath(vault, selected))} title="Pin this note so it can be typed into a prompt">Pin this note</button>
      </div>
      {note
        ? <>
          <MarkdownText text={prepareNote(note.content)} />
          {note.truncated && <p style={styles.meta}>Only the first 512 KB of this note is shown.</p>}
        </>
        : !error && <p style={styles.meta}>Reading…</p>}
    </article>}
  </section>
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 12, borderTop: '1px solid var(--bs-border)' },
  head: { display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 },
  title: { margin: 0, fontSize: 15, fontWeight: 600 },
  meta: { fontSize: 12, color: 'var(--bs-fg-muted)' },
  search: { padding: '6px 8px', borderRadius: 8, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg)', font: 'inherit' },
  list: { listStyle: 'none', margin: 0, padding: 0, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--bs-border)', borderRadius: 8 },
  row: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 10, alignItems: 'baseline', width: '100%', padding: '5px 8px', border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer' },
  rowActive: { background: 'var(--bs-bg-dark)' },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  note: { padding: '10px 14px', border: '1px solid var(--bs-border)', borderRadius: 10, fontSize: 14, lineHeight: 1.6 },
  link: { marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--bs-fg-muted)', cursor: 'pointer', fontSize: 12 },
}
