import { useRef, useState } from 'react'
import { bdAddLabel, bdClaim, bdCloseIssue, bdNote, bdRemoveLabel, bdSetStatus } from '../types/issue'
import { invalidate } from '../lib/bdCache'

/** Native issue operations: Tab/arrow keys choose, Cmd/Ctrl+Enter applies. */
export function BeadActions({ repoPath, id, onChanged }: { repoPath: string; id: string; onChanged: () => void }) {
  const [action, setAction] = useState('claim')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const needsText = ['note', 'add-label', 'remove-label'].includes(action)
  async function apply() {
    if (pending.current || (needsText && !text.trim())) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      if (action === 'claim') await bdClaim(repoPath, id)
      else if (action === 'close') await bdCloseIssue(repoPath, id, text.trim() || null)
      else if (action === 'note') await bdNote(repoPath, id, text.trim())
      else if (action === 'add-label') await bdAddLabel(repoPath, id, text.trim())
      else if (action === 'remove-label') await bdRemoveLabel(repoPath, id, text.trim())
      else await bdSetStatus(repoPath, id, action)
      invalidate(repoPath)
      setText('')
      onChanged()
    } catch (err) { setError(String(err)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <form onSubmit={event => { event.preventDefault(); void apply() }} onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void apply() }
  }} style={{ display: 'grid', gap: 8, marginTop: 16 }}>
    <label>Bead command <select aria-label="Bead command" value={action} disabled={busy} onChange={event => setAction(event.target.value)}>
      <option value="claim">Claim</option><option value="open">Reopen</option>
      <option value="in_progress">Mark in progress</option><option value="blocked">Mark blocked</option>
      <option value="close">Close with reason</option><option value="note">Append note</option>
      <option value="add-label">Add label</option><option value="remove-label">Remove label</option>
    </select></label>
    {(needsText || action === 'close') && <input aria-label="Command text" placeholder={action === 'close' ? 'Reason (optional)' : action === 'note' ? 'Note' : 'Label'} value={text} disabled={busy} onChange={event => setText(event.target.value)} />}
    <button disabled={busy || (needsText && !text.trim())}>{busy ? 'Applying…' : 'Apply command · Cmd/Ctrl+Enter'}</button>
    {error && <p role="alert">{error}</p>}
  </form>
}
