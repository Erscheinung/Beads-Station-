import type { BeadState } from './beadMap'

export const STATE_LABEL: Record<BeadState, string> = {
  ready: 'Ready',
  in_progress: 'In progress',
  blocked: 'Blocked',
  closed: 'Done',
}

export function StatePill({ state, quiet = false }: { state: BeadState; quiet?: boolean }) {
  return <span className={`du-pill du-pill--${state}${quiet ? ' du-pill--quiet' : ''}`}>{STATE_LABEL[state]}</span>
}

export const PRIORITY_LABEL = ['Critical', 'High', 'Medium', 'Low', 'Backlog']
