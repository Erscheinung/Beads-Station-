import { useVim } from '../state/vim'
import { LEADER_SHORTCUTS } from '../state/commands'

/**
 * Centered modal cheatsheet shown while the leader key is held. Subscribes
 * to the vim store and self-hides when leaderActive flips false. Pure
 * presentational — no key handling lives here; useVimNav owns the keymap.
 */
export function WhichKey() {
  const { leaderActive, focused } = useVim()
  if (!leaderActive) return null
  const context = focused === 'terminal' ? 'terminal' : 'global'
  const hints = LEADER_SHORTCUTS[context]

  return (
    <div
      role="dialog"
      aria-label="Leader key menu"
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 420,
        background: 'var(--bs-bg-elev)',
        border: '1px solid var(--bs-border)',
        borderRadius: 4,
        padding: 16,
        zIndex: 9999,
        boxShadow: 'var(--bs-shadow-modal)',
        fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--bs-fg-muted)',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          marginBottom: 12,
        }}
      >
        LEADER
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          rowGap: 12,
          columnGap: 24,
          fontSize: 12,
        }}
      >
        {hints.map(h => (
          <Row key={h.key} k={h.key} label={h.label} />
        ))}
      </div>
      <div
        style={{
          marginTop: 14,
          paddingTop: 10,
          borderTop: '1px solid var(--bs-border)',
          fontSize: 10,
          color: 'var(--bs-fg-muted)',
        }}
      >
        Space arms leader &middot; Cmd/Ctrl-P arms from any input · {context} context
      </div>
    </div>
  )
}

function Row({ k, label }: { k: string; label: string }) {
  return (
    <>
      <span style={{ color: 'var(--bs-cyan)' }}>{k}</span>
      <span style={{ color: 'var(--bs-fg)' }}>{label}</span>
    </>
  )
}
