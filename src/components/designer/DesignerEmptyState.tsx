// Code-9z4 — designer-skin first-run / no-project state.
//
// Parity with the terminal Dashboard: when projects_list resolves empty (a
// fresh machine with no git repos under ~/Code) OR rejects (a slow/broken
// backend), the designer skin must not leave every right-panel surface stuck on
// a bare "No project selected." with no path forward. This renders a single
// purposeful panel that (a) says what the app scans, and (b) distinguishes an
// empty list from a load failure via the error variant.
//
// Designer-light theme only (--bs-* / --du-* tokens), matching DesignerShell.

export function DesignerEmptyState({ error }: { error?: string | null }) {
  return (
    <div className="du-theme" style={styles.root} data-testid="designer-empty-state">
      <div style={styles.card}>
        <div style={styles.wordmark}>
          <span style={styles.dot} />
          <span style={styles.wordmarkText}>Beads Station</span>
        </div>

        {error ? (
          <>
            <p style={styles.title}>Couldn't load projects</p>
            <p style={styles.body}>{error}</p>
            <p style={styles.hint}>
              The backend didn't return a project list. This is a load failure,
              not an empty machine — retry once the backend is up.
            </p>
          </>
        ) : (
          <>
            <p style={styles.title}>No projects yet</p>
            <p style={styles.body}>
              Beads Station scans <code style={styles.code}>~/Code</code> for git
              repositories and surfaces the ones tracked with beads.
            </p>
            <p style={styles.hint}>
              Add a git repo under <code style={styles.code}>~/Code</code> (or
              wire one into <code style={styles.code}>.beads/config.yaml</code>),
              then reopen the window to pick it up.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: '100vh',
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bs-bg-dark)',
    color: 'var(--bs-fg)',
    fontFamily: 'var(--du-font-sans)',
    padding: 40,
  },
  card: {
    maxWidth: 480,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: 32,
    background: 'var(--bs-bg)',
    border: '1px solid var(--bs-border)',
    borderRadius: 12,
  },
  wordmark: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  dot: {
    display: 'inline-block',
    width: 12,
    height: 12,
    borderRadius: '50%',
    background: 'var(--bs-orange)',
    flexShrink: 0,
  },
  wordmarkText: {
    fontWeight: 600,
    fontSize: 15,
    letterSpacing: '-0.01em',
    color: 'var(--bs-fg)',
  },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--bs-fg)',
  },
  body: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.55,
    color: 'var(--bs-fg-muted)',
  },
  hint: {
    margin: '4px 0 0',
    fontSize: 12,
    lineHeight: 1.55,
    color: 'var(--bs-fg-faint)',
  },
  code: {
    fontFamily: 'var(--du-font-mono, ui-monospace, Menlo, monospace)',
    fontSize: 12,
    padding: '1px 5px',
    borderRadius: 4,
    background: 'var(--bs-bg-dark)',
    border: '1px solid var(--bs-border)',
    color: 'var(--bs-fg-muted)',
  },
}
