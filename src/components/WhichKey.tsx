import { useVim } from '../state/vim'

interface KeyHint {
  key: string
  label: string
}

// Static leader-key cheatsheet. Kept inside the module so the array is stable
// across renders without a useMemo dance.
const HINTS: KeyHint[] = [
  { key: 'p', label: 'pick project' },
  { key: 'b', label: 'focus board' },
  { key: 'c', label: 'focus chat' },
  { key: 's', label: 'focus sidebar' },
  { key: 'q', label: 'quit' },
]

/**
 * Centered modal cheatsheet shown while the leader key is held. Subscribes
 * to the vim store and self-hides when leaderActive flips false. Pure
 * presentational — no key handling lives here; useVimNav owns the keymap.
 */
export function WhichKey() {
  const { leaderActive } = useVim()
  if (!leaderActive) return null

  return (
    <div
      role="dialog"
      aria-label="Leader key menu"
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 360,
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
        {HINTS.map(h => (
          <Row key={h.key} k={h.key} label={h.label} />
        ))}
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
