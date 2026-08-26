// Empty-state dashboard shown when no project is loaded or selected.
// ASCII BEADS title + tip table. Tokyonight tokens only, JetBrains Mono.

const BEADS_ASCII = String.raw`
██████╗ ███████╗ █████╗ ██████╗ ███████╗
██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝
██████╔╝█████╗  ███████║██║  ██║███████╗
██╔══██╗██╔══╝  ██╔══██║██║  ██║╚════██║
██████╔╝███████╗██║  ██║██████╔╝███████║
╚═════╝ ╚══════╝╚═╝  ╚═╝╚═════╝ ╚══════╝
`

const RULE = '─'.repeat(60)

const TIPS: Array<[string, string]> = [
  ['j/k', 'navigate'],
  ['Enter', 'open'],
  ['gq', 'quit'],
  ['/', 'search'],
]

export function Dashboard({ error }: { error?: string | null } = {}) {
  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: 'var(--bs-bg)',
        fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
        userSelect: 'none',
      }}
    >
      <pre
        style={{
          margin: 0,
          color: 'var(--bs-fg-muted)',
          fontSize: 14,
          lineHeight: 1.1,
          letterSpacing: 0,
          textAlign: 'center',
        }}
      >
        {BEADS_ASCII}
      </pre>

      <pre
        style={{
          margin: 0,
          color: 'var(--bs-border)',
          fontSize: 12,
          lineHeight: 1,
        }}
      >
        {RULE}
      </pre>

      <div style={{ fontSize: 12, color: 'var(--bs-fg-muted)' }}>
        press{' '}
        <span style={{ color: 'var(--bs-cyan)' }}>{'<leader>'}</span>
        <span style={{ color: 'var(--bs-cyan)' }}>p</span> to pick project
      </div>

      {error && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--bs-red)',
            maxWidth: 520,
            textAlign: 'center',
            wordBreak: 'break-word',
          }}
        >
          Couldn't load projects: {error}
        </div>
      )}

      <table
        style={{
          borderCollapse: 'collapse',
          fontSize: 12,
          marginTop: 8,
        }}
      >
        <tbody>
          {TIPS.map(([key, desc]) => (
            <tr key={key}>
              <td
                style={{
                  color: 'var(--bs-cyan)',
                  padding: '2px 16px 2px 0',
                  textAlign: 'left',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {key}
              </td>
              <td style={{ color: 'var(--bs-fg-muted)', padding: '2px 0' }}>
                {desc}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
