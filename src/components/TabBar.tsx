import type { Project } from '../state/projects'

interface TabBarProps {
  projects: Project[]
  activeId: string | null
  onSelect: (id: string) => void
}

/**
 * Bufferline-style horizontal tab strip. Tokyonight palette only — no new
 * colors. Active tab gets a solid bottom-border in --accent and brightened
 * foreground; inactive tabs sit muted. Horizontal overflow scrolls with a
 * thin scrollbar.
 */
export function TabBar({ projects, activeId, onSelect }: TabBarProps) {
  return (
    <div
      className="tabbar"
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'stretch',
        height: 32,
        background: 'var(--bg)',
        borderBottom: '1px solid var(--border)',
        overflowX: 'auto',
        overflowY: 'hidden',
        flexShrink: 0,
      }}
    >
      {projects.map(p => {
        const active = p.id === activeId
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            title={p.path}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 14px',
              height: '100%',
              background: active ? 'var(--bg-elev)' : 'transparent',
              color: active ? 'var(--fg)' : 'var(--fg)',
              opacity: active ? 1 : 0.55,
              border: 'none',
              borderRight: '1px solid var(--border)',
              borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
              fontFamily: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: p.hasBeads
                  ? active
                    ? 'var(--accent)'
                    : 'var(--border)'
                  : 'transparent',
                border: p.hasBeads ? 'none' : '1px solid var(--border)',
              }}
            />
            <span>{p.name}</span>
          </button>
        )
      })}
    </div>
  )
}
