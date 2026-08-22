import { useMemo } from 'react'
import { BdLiveProvider } from '../../lib/BdLiveProvider'
import { useProjects } from '../../state/projects'
import { useTermPanes, leavesOf } from '../../state/termPanes'
import { useBdSnapshot } from '../../lib/bdCache'
import { useConductorStatus } from '../../lib/useConductorStatus'
import type { ConductorStatus } from '../../lib/conductorBridge'

// DU3 (Code-d7j) — the Active-agents panel. A calm, READ-ONLY summary of what
// the conductor + chat panes are doing right now. Approve/reject stays in
// GateCockpit (RV5.0); this is a VIEW, never a controller.
//
// Data sources, all already live and self-contained:
//   - useConductorStatus() — the conductor's current pulse (one at a time; a
//     fanout tick reports an aggregate detail like "3 builder(s) advanced").
//   - useTermPanes() — the interactive Claude chat panes (RV2 agent leaves).
//   - useBdSnapshot(repoPath).ready[0] — the NEXT UP auto-picked bead.
//
// Like BeadGraph, this supplies its OWN BdLiveProvider — DesignerShell mounts
// outside App's provider, and useBdSnapshot -> useBdLiveContext throws without
// one. The conductor + pane stores are self-contained (module-level / event),
// so only the bd snapshot needs the provider.

type AgentState = 'resolving' | 'reviewing' | 'done' | 'deferred' | 'error' | 'resting'

interface AgentCard {
  key: string
  /** "Conductor · pane N" style heading. */
  label: string
  /** Opus·xhigh / Sonnet·medium — the tier badge. */
  tier: string | null
  /** "Resolving Code-8ro" / "Reviewing diff" / "Closed ✓ Code-ia4". */
  action: string
  state: AgentState
  /** 0..1 progress fill; done=1, active=indeterminate-ish partial. */
  progress: number
}

const STATE_COLOR: Record<AgentState, string> = {
  resolving: 'var(--bs-blue)',
  reviewing: 'var(--bs-yellow)',
  done: 'var(--bs-green)',
  deferred: 'var(--bs-yellow)',
  error: 'var(--bs-red)',
  resting: 'var(--bs-fg-faint)',
}

/** Map the conductor's wire state to an agent-card presentation. */
function conductorCard(status: ConductorStatus): AgentCard | null {
  const bead = status.bead_id
  const detail = status.detail ?? ''
  // A fanout tick prefixes its detail with a builder count ("3 builder(s)…").
  const fanout = /^(\d+)\s+builder/i.exec(detail)?.[1] ?? null
  const label = fanout ? `Conductor · ${fanout} builders` : 'Conductor · pulse'

  switch (status.state) {
    case 'waking':
      return {
        key: 'conductor',
        label,
        tier: null,
        action: bead ? `Resolving ${bead}` : 'Waking…',
        state: 'resolving',
        progress: 0.25,
      }
    case 'awake':
      return {
        key: 'conductor',
        label,
        tier: null,
        action: bead ? `Advanced ${bead}` : detail || 'Pulse complete',
        state: 'done',
        progress: 1,
      }
    case 'deferred':
      return {
        key: 'conductor',
        label,
        tier: null,
        action: bead ? `Deferred ${bead}` : 'Deferred',
        state: 'deferred',
        progress: 0.5,
      }
    case 'error':
      return {
        key: 'conductor',
        label,
        tier: null,
        action: detail || 'Pulse error',
        state: 'error',
        progress: 1,
      }
    case 'idle':
    case 'stopped':
    default:
      return null // resting — surfaced by the empty state, not a card
  }
}

function AgentsInner({ repoPath }: { repoPath: string }) {
  const { projects } = useProjects()

  const status = useConductorStatus()
  const panes = useTermPanes()
  const snap = useBdSnapshot(repoPath)

  // Interactive chat-agent panes across all tabs (RV2 agent leaves). Each is a
  // human-driven Claude session, distinct from the autonomous conductor pulse.
  const chatCards = useMemo<AgentCard[]>(() => {
    const cards: AgentCard[] = []
    let n = 0
    for (const tab of panes.tabs) {
      for (const leaf of leavesOf(tab.root)) {
        if (leaf.agent == null) continue
        n += 1
        const proj = projects.find(p => p.id === leaf.agent!.projectId)
        cards.push({
          key: leaf.agent.bridgeId,
          label: `Chat · pane ${n}`,
          tier: leaf.agent.permissionMode === 'plan' ? 'plan' : null,
          action: proj ? `Working ${proj.name}` : 'Chat session',
          state: 'resolving',
          progress: 0.4,
        })
      }
    }
    return cards
  }, [panes, projects])

  const conductor = status ? conductorCard(status) : null
  const cards = [conductor, ...chatCards].filter(Boolean) as AgentCard[]

  const nextUp = snap.ready[0] ?? null

  return (
    <div style={styles.wrap}>
      {cards.length === 0 && (
        <p style={styles.empty}>
          No agents running. Start the conductor or open a chat pane.
        </p>
      )}

      <div style={styles.list}>
        {cards.map(c => (
          <div key={c.key} style={styles.card}>
            <div style={styles.headRow}>
              <span style={{ ...styles.dot, background: STATE_COLOR[c.state] }} />
              <span style={styles.cardLabel}>{c.label}</span>
              {c.tier && <span style={styles.tierBadge}>{c.tier}</span>}
            </div>
            <p style={styles.action}>{c.action}</p>
            <div style={styles.track}>
              <div
                style={{
                  ...styles.fill,
                  width: `${Math.round(c.progress * 100)}%`,
                  background: STATE_COLOR[c.state],
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* NEXT UP · auto-picked */}
      <div style={styles.nextCard}>
        <p style={styles.nextLabel}>NEXT UP · auto-picked</p>
        {nextUp ? (
          <>
            <p style={styles.nextTitle}>
              <span style={styles.nextId}>{nextUp.id}</span> · {nextUp.title}
            </p>
            <p style={styles.nextHint}>
              No blockers. Claude claims it the moment a pane frees up.
            </p>
          </>
        ) : (
          <p style={styles.nextHint}>
            {snap.loaded ? 'Nothing ready — queue is clear.' : 'Reading the queue…'}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Entry point mounted at the DU3 placeholder in DesignerShell. Supplies its own
 * BdLiveProvider (the shell renders outside App's provider) and resolves the
 * active project's repoPath the same way BeadGraph does.
 */
export function ActiveAgents() {
  const { projects, activeId } = useProjects()
  const active = projects.find(p => p.id === activeId) ?? projects[0] ?? null

  return (
    <BdLiveProvider>
      <AgentsInner repoPath={active?.path ?? ''} />
    </BdLiveProvider>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  empty: {
    margin: 0,
    fontSize: 12,
    color: 'var(--bs-fg-muted)',
    lineHeight: 1.45,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  card: {
    padding: 12,
    background: 'var(--bs-bg-dark)',
    border: '1px solid var(--bs-border)',
    borderRadius: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  headRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  cardLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--bs-fg)',
    flex: 1,
  },
  tierBadge: {
    fontSize: 10,
    fontFamily: 'var(--du-font-mono)',
    color: 'var(--bs-fg-muted)',
    border: '1px solid var(--bs-border)',
    borderRadius: 5,
    padding: '1px 6px',
  },
  action: {
    margin: 0,
    fontSize: 11,
    color: 'var(--bs-fg-muted)',
    lineHeight: 1.4,
  },
  track: {
    height: 4,
    borderRadius: 2,
    background: 'var(--bs-border)',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 2,
    transition: 'width 400ms ease',
  },
  nextCard: {
    padding: 12,
    background: 'color-mix(in srgb, var(--bs-orange) 6%, var(--bs-bg-dark))',
    border: '1px dashed var(--bs-border)',
    borderRadius: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  nextLabel: {
    margin: 0,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.1em',
    color: 'var(--bs-fg-faint)',
  },
  nextTitle: {
    margin: 0,
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--bs-fg)',
    lineHeight: 1.4,
  },
  nextId: {
    fontFamily: 'var(--du-font-mono)',
    color: 'var(--bs-orange)',
  },
  nextHint: {
    margin: 0,
    fontSize: 11,
    color: 'var(--bs-fg-faint)',
    lineHeight: 1.45,
  },
}
