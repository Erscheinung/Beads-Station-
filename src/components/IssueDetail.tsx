// R3 — issue detail pane ("bd view").
//
// The audit found that the sidebar's `issue:open` CustomEvent (emitted by
// useTreeNav.open() on Enter/o) had NO listener — pressing Enter on an issue
// did nothing, which the user experienced as "bd view crashes / no-ops". This
// component is that missing listener: it fetches `bd_show` for the requested
// id and renders a bottom-anchored overlay panel. All fetch failures route
// through safeInvoke → a toast (bdShow rethrows, we catch locally and show an
// inline error), so a bad id or broken bd never white-screens the app.

import { useEffect, useRef, useState } from 'react'
import { bdShow, type Issue } from '../types/issue'
import { BeadActions } from './BeadActions'

interface Props {
  repoPath: string
}

interface OpenState {
  id: string
  issue: Issue | null
  error: string | null
  loading: boolean
}

/**
 * Listens for the `issue:open` window event and renders a detail overlay for
 * the selected issue. Escape or the close button dismisses it. Fetching is
 * guarded: a rejected bd_show surfaces an inline error row (and safeInvoke's
 * global toast) rather than throwing into render.
 */
export function IssueDetail({ repoPath }: Props) {
  const [open, setOpen] = useState<OpenState | null>(null)
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => { setOpen(null) }, [repoPath])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    card.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [open?.id])

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { id?: string; repoPath?: string } | undefined
      if (detail?.repoPath && detail.repoPath !== repoPath) return
      const id = detail?.id
      if (!id) return // vim `o` with no tree cursor id — nothing to show.
      setOpen({ id, issue: null, error: null, loading: true })
    }
    window.addEventListener('issue:open', onOpen as EventListener)
    return () => window.removeEventListener('issue:open', onOpen as EventListener)
  }, [])

  // Fetch whenever a new id is opened. Aborts stale fetches via a local flag.
  useEffect(() => {
    if (!open || !open.loading) return
    let cancelled = false
    ;(async () => {
      try {
        const issue = await bdShow(repoPath, open.id)
        if (cancelled) return
        setOpen(o => (o && o.id === issue.id ? { ...o, issue, loading: false } : o))
      } catch (err) {
        if (cancelled) return
        setOpen(o => (o ? { ...o, error: String(err), loading: false } : o))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, repoPath])

  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open) return null

  return (
    <div className="bs-detail-backdrop" onClick={() => setOpen(null)}>
      <div
        className="bs-detail-card"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="issue detail"
        aria-modal="true"
        ref={card}
        tabIndex={-1}
        onKeyDown={event => {
          if (event.key !== 'Tab') return
          const nodes = Array.from(card.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])
          const first = nodes[0], last = nodes[nodes.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === card.current)) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }}
      >
        <div className="bs-detail-head">
          <span className="bs-detail-id">{open.id}</span>
          <button
            className="bs-detail-x"
            type="button"
            onClick={() => setOpen(null)}
            aria-label="close"
          >
            x
          </button>
        </div>

        {open.loading && <div className="bs-detail-loading">loading…</div>}

        {open.error && (
          <div className="bs-detail-error">
            failed to load {open.id}: {open.error}
          </div>
        )}

        {open.issue && (
          <div className="bs-detail-body">
            <div className="bs-detail-title">{open.issue.title}</div>
            <div className="bs-detail-meta">
              <span>status={open.issue.status}</span>
              <span>P{open.issue.priority}</span>
              <span>{open.issue.issue_type}</span>
              {open.issue.assignee && <span>@{open.issue.assignee}</span>}
            </div>
            {open.issue.labels && open.issue.labels.length > 0 && (
              <div className="bs-detail-labels">
                {open.issue.labels.map(l => (
                  <span key={l} className="bs-detail-label">
                    {l}
                  </span>
                ))}
              </div>
            )}
            {open.issue.description && (
              <pre className="bs-detail-desc">{open.issue.description}</pre>
            )}
            {open.issue.acceptance_criteria && <><h3>Acceptance criteria</h3><pre className="bs-detail-desc">{open.issue.acceptance_criteria}</pre></>}
            {open.issue.notes && <><h3>Notes</h3><pre className="bs-detail-desc">{open.issue.notes}</pre></>}
            {open.issue.dependencies.length > 0 && <div>Dependencies: {open.issue.dependencies.map(dep => <button key={`${dep.depends_on_id}:${dep.type}`} onClick={() => setOpen({ id: dep.depends_on_id, issue: null, error: null, loading: true })}>{dep.depends_on_id} · {dep.type}</button>)}</div>}
            <div className="bs-detail-counts">
              deps={open.issue.dependency_count} · dependents=
              {open.issue.dependent_count} · comments={open.issue.comment_count}
            </div>
            <BeadActions key={open.id} repoPath={repoPath} id={open.id} onChanged={() => setOpen(current => current ? { ...current, loading: true, error: null } : current)} />
          </div>
        )}
      </div>
    </div>
  )
}
