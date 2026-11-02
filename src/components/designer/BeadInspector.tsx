import { useEffect, useState } from 'react'
import { bdShow, type Issue } from '../../types/issue'
import { classifyBead, type BeadRelations } from './beadMap'
import { PRIORITY_LABEL, StatePill } from './beadPresentation'

/** Links from one bead to its neighbours, shared by the inspector and the request page. */
export function BeadLinks({ issue, issues, relations, readyIds, onSelect }: {
  issue: Issue
  issues: Issue[]
  relations: Map<string, BeadRelations>
  readyIds: ReadonlySet<string>
  onSelect: (id: string) => void
}) {
  const links = relations.get(issue.id)
  if (!links) return null
  const byId = new Map(issues.map(candidate => [candidate.id, candidate]))
  const group = (label: string, ids: string[]) => {
    const found = ids.map(id => byId.get(id)).filter((value): value is Issue => Boolean(value))
    if (found.length === 0) return null
    return <div className="du-links__group" key={label}>
      <h4>{label} <span>{found.length}</span></h4>
      {found.map(other => (
        <button key={other.id} className="du-link" data-bead-link={other.id} onClick={() => onSelect(other.id)}>
          <span className={`du-dot du-dot--${classifyBead(other, readyIds)}`} />
          <span className="du-link__title">{other.title}</span>
          <span className="du-link__id">{other.id}</span>
        </button>
      ))}
    </div>
  }
  return <div className="du-links">
    {group('Part of', links.parent ? [links.parent] : [])}
    {group('Waiting for', links.blockedBy)}
    {group('Holds up', links.blocks)}
    {group('Contains', links.children)}
    {group('Related', links.related)}
  </div>
}

/** One bead with everything bd knows, beside the map. */
export function BeadInspector({ repoPath, issue, issues, relations, readyIds, onSelect, onOpen, onOpenSession, onClose }: {
  repoPath: string
  issue: Issue | null
  issues: Issue[]
  relations: Map<string, BeadRelations>
  readyIds: ReadonlySet<string>
  onSelect: (id: string) => void
  onOpen: (issue: Issue) => void
  onOpenSession?: (issue: Issue) => void
  onClose: () => void
}) {
  // The list carries a summary; notes and acceptance criteria come from `bd show`.
  const [detail, setDetail] = useState<Issue | null>(null)
  const id = issue?.id ?? null
  useEffect(() => {
    setDetail(null)
    if (!id) return
    let cancelled = false
    bdShow(repoPath, id).then(value => { if (!cancelled) setDetail(value) }).catch(() => {})
    return () => { cancelled = true }
  }, [repoPath, id, issue?.updated_at])

  if (!issue) return null
  const full = detail ?? issue
  const state = classifyBead(issue, readyIds)
  return <aside className="du-inspector" aria-label="Bead details" data-testid="bead-inspector">
    <div className="du-inspector__head">
      <span className="du-inspector__id">{issue.id}</span>
      <StatePill state={state} />
      <button className="du-icon-btn" aria-label="Close details" onClick={onClose}><span className="codicon codicon-close" aria-hidden /></button>
    </div>
    <h3>{issue.title}</h3>
    <p className="du-inspector__meta">{issue.issue_type} · {PRIORITY_LABEL[issue.priority] ?? `P${issue.priority}`} priority{issue.assignee ? ` · ${issue.assignee}` : ''}</p>
    <div className="du-inspector__actions">
      <button className="du-btn du-btn--primary" onClick={() => onOpen(issue)}>Open</button>
      {onOpenSession && state !== 'closed' && <button className="du-btn" onClick={() => onOpenSession(issue)}>Live session</button>}
    </div>
    {full.description && <section><h4>Description</h4><p className="du-prose">{full.description}</p></section>}
    {full.acceptance_criteria && <section><h4>Acceptance</h4><p className="du-prose">{full.acceptance_criteria}</p></section>}
    {full.notes && <section><h4>Notes</h4><p className="du-prose">{full.notes}</p></section>}
    <BeadLinks issue={issue} issues={issues} relations={relations} readyIds={readyIds} onSelect={onSelect} />
  </aside>
}
