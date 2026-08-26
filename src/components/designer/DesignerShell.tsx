import { useCallback, useEffect, useState } from 'react'
import '../../theme/designer-light.css'
import { BeadGraph } from './BeadGraph'
import { GateCockpit } from './GateCockpit'
import { SensorsPanel } from './SensorsPanel'
import { ConductorControl } from './ConductorControl'
import { ActiveAgents } from './ActiveAgents'
import { Timeline } from './Timeline'
import { DesignerEmptyState } from './DesignerEmptyState'
import { useProjects } from '../../state/projects'
import { setSkin } from '../../state/skin'
import { conductorSetDefaultTier } from '../../lib/conductorBridge'
import { useConductorStatus, statusPresentation } from '../../lib/useConductorStatus'

type Tier = 'everyday' | 'heavy'
type NavItem = 'board' | 'graph' | 'agents' | 'timeline'

const NAV_ITEMS: { id: NavItem; label: string }[] = [
  { id: 'board',    label: 'Board' },
  { id: 'graph',    label: 'Bead graph' },
  { id: 'agents',   label: 'Agents' },
  { id: 'timeline', label: 'Timeline' },
]

const TIER_META = {
  everyday: { model: 'Sonnet', effort: 'medium effort', heavy: 'Switch to Heavy for ultracode (Opus · xhigh) on gnarly work' },
  heavy:    { model: 'Opus',   effort: 'xhigh effort',  heavy: 'Running in ultracode mode. Switch to Everyday for routine work.' },
}

export function DesignerShell() {
  const [tier, setTier] = useState<Tier>('everyday')
  const [nav, setNav]   = useState<NavItem>('graph')

  // Code-9z4 — gate the whole shell on project availability. Without this every
  // right-panel surface independently renders "No project selected." on a fresh
  // machine (or a rejected projects_list), with no path forward. Show one
  // purposeful first-run / error panel instead.
  const { projects, loaded, error: projectsError } = useProjects()

  const meta = TIER_META[tier]

  // DU3 (Code-d7j) — the toggle drives BOTH the ACTIVE TIER card (local state)
  // AND the conductor's default tier ceiling (Everyday=Sonnet/medium,
  // Heavy=Opus/xhigh). Per-bead size/model labels still override the default.
  // Fire-and-forget: the setting is a cheap atomic write on the Rust side, and
  // a failure (e.g. no backend in the vite mock) must not block the UI toggle.
  const selectTier = useCallback((next: Tier) => {
    setTier(next)
    void conductorSetDefaultTier(next).catch(() => {})
  }, [])

  // Empty (fresh machine) or rejected (slow/broken backend) project load: show
  // the first-run panel, not a shell full of "No project selected." Render the
  // shell only once projects_list has resolved with at least one project (or is
  // still loading — the surfaces show their own loading state then).
  if (loaded && projects.length === 0) {
    return <DesignerEmptyState error={projectsError} />
  }

  return (
    <div className="du-theme" style={styles.root}>
      {/* ── Top bar ── */}
      <header style={styles.topbar}>
        <div style={styles.wordmark}>
          <span style={styles.dot} />
          <span style={styles.wordmarkText}>Beads Station</span>
        </div>
        <div style={styles.topbarRight}>
          <button
            style={styles.skinBtn}
            onClick={() => setSkin('terminal')}
            title="Switch to the terminal skin"
          >
            Terminal skin
          </button>
          <div style={styles.tierToggle} role="group" aria-label="Workflow tier">
            <button
              style={{ ...styles.tierBtn, ...(tier === 'everyday' ? styles.tierBtnActive : {}) }}
              onClick={() => selectTier('everyday')}
            >
              Everyday
            </button>
            <button
              style={{ ...styles.tierBtn, ...(tier === 'heavy' ? styles.tierBtnActive : {}) }}
              onClick={() => selectTier('heavy')}
            >
              Heavy
            </button>
          </div>
        </div>
      </header>

      {/* ── Body: sidebar + main + right ── */}
      <div style={styles.body}>
        {/* Left sidebar */}
        <aside style={styles.sidebar}>
          <nav style={styles.nav}>
            <p style={styles.navGroup}>WORKSPACE</p>
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                style={{ ...styles.navItem, ...(nav === item.id ? styles.navItemActive : {}) }}
                onClick={() => setNav(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Active tier card */}
          <div style={styles.tierCard}>
            <p style={styles.tierCardLabel}>ACTIVE TIER</p>
            <p style={styles.tierCardName}>
              {tier === 'everyday' ? 'Everyday' : 'Heavy'}
              <span style={styles.tierCardModel}> · {meta.model}</span>
            </p>
            <p style={styles.tierCardEffort}>{meta.effort}</p>
            <p style={styles.tierCardHint}>{meta.heavy}</p>
          </div>
        </aside>

        {/* Center — main view */}
        <main style={styles.main}>
          <CenterView nav={nav} />
        </main>

        {/* Right — gate cockpit (RV5.0) + sensors (RV5.1) + conductor (Code-9ud) + agents placeholder (DU3) */}
        <aside style={styles.rightPanel}>
          <GateCockpit />
          <div style={styles.panelDivider} />
          <SensorsPanel />
          <div style={styles.panelDivider} />
          <ConductorControl />
          <div style={styles.panelDivider} />
          <p style={styles.panelLabel}>ACTIVE AGENTS</p>
          <div id="du-agents-panel" style={styles.panelPlaceholder}>
            <ActiveAgents />
          </div>
        </aside>
      </div>

      {/* ── Footer — live conductor status (Code-9ud) ── */}
      <ConductorFooter />
    </div>
  )
}

// Footer driven by the shared conductor_status subscription — one source of
// truth with ConductorControl (both read useConductorStatus).
//
// DU4 (Code-kp4) — the "Claude is awake" heartbeat. The dot goes green while a
// pulse landed recently (< HEARTBEAT_FRESH_MS ago) and dims once the loop is
// stopped or has gone quiet, so a glance at the footer tells you whether Claude
// is still breathing. A 1s tick re-evaluates freshness even between pulses (the
// status event only fires on a pulse, so without the tick a fresh dot would
// never decay to dim on its own).
const HEARTBEAT_FRESH_MS = 120_000

function ConductorFooter() {
  const status = useConductorStatus()
  const [now, setNow] = useState(() => Date.now())

  const stopped = status == null || status.state === 'stopped'

  useEffect(() => {
    if (stopped) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [stopped])

  const pres = statusPresentation(status)
  const lastPulse = status?.last_pulse_ms ?? null
  const fresh = lastPulse != null && now - lastPulse < HEARTBEAT_FRESH_MS && !stopped

  const dot = fresh ? 'var(--bs-green)' : 'var(--bs-fg-faint)'
  const text = stopped
    ? pres.text
    : fresh
      ? `Claude is awake · ${pres.text}`
      : `${pres.text} · resting`

  return (
    <footer style={styles.footer}>
      <span
        style={{
          ...styles.footerDot,
          background: dot,
          // Soft breathing pulse only while genuinely fresh.
          animation: fresh ? 'du-heartbeat 1.8s ease-in-out infinite' : 'none',
        }}
      />
      <span style={styles.footerText}>{text}</span>
    </footer>
  )
}

function CenterView({ nav }: { nav: NavItem }) {
  if (nav === 'graph') {
    return (
      <div id="du-bead-graph" style={styles.graphSlot}>
        <BeadGraph />
      </div>
    )
  }
  if (nav === 'timeline') {
    return (
      <div id="du-timeline" style={styles.graphSlot}>
        <Timeline />
      </div>
    )
  }
  return (
    <div style={styles.viewPlaceholder}>
      <p style={styles.graphPlaceholderText}>{nav.charAt(0).toUpperCase() + nav.slice(1)}</p>
      <p style={styles.graphPlaceholderSub}>Coming in a later DU phase.</p>
    </div>
  )
}

// ── Inline styles ─────────────────────────────────────────────────────────────
// Using inline styles (not CSS classes) for the shell frame so the designer
// surface has zero class-name surface area that could collide with tokyonight.
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'grid',
    gridTemplateRows: '52px 1fr 36px',
    height: '100vh',
    background: 'var(--bs-bg-dark)',
    color: 'var(--bs-fg)',
    fontFamily: 'var(--du-font-sans)',
    fontSize: 14,
  },
  topbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 24px',
    background: 'var(--bs-bg)',
    borderBottom: '1px solid var(--bs-border)',
    flexShrink: 0,
  },
  wordmark: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
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
  tierToggle: {
    display: 'flex',
    border: '1px solid var(--bs-border)',
    borderRadius: 8,
    overflow: 'hidden',
  },
  topbarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  skinBtn: {
    padding: '5px 12px',
    background: 'transparent',
    border: '1px solid var(--bs-border)',
    borderRadius: 8,
    color: 'var(--bs-fg-muted)',
    fontSize: 13,
    fontFamily: 'var(--du-font-sans)',
    cursor: 'pointer',
    transition: 'background 120ms ease, color 120ms ease',
  },
  tierBtn: {
    padding: '5px 16px',
    background: 'transparent',
    border: 'none',
    borderRight: '1px solid var(--bs-border)',
    color: 'var(--bs-fg-muted)',
    fontSize: 13,
    fontFamily: 'var(--du-font-sans)',
    cursor: 'pointer',
    transition: 'background 120ms ease, color 120ms ease',
  },
  tierBtnActive: {
    background: 'var(--bs-orange)',
    color: '#ffffff',
    fontWeight: 600,
  },
  body: {
    display: 'grid',
    gridTemplateColumns: '220px 1fr 280px',
    minHeight: 0,
    overflow: 'hidden',
  },
  sidebar: {
    background: 'var(--bs-bg)',
    borderRight: '1px solid var(--bs-border)',
    display: 'flex',
    flexDirection: 'column',
    padding: '20px 0',
    gap: 0,
    overflow: 'hidden',
  },
  nav: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    padding: '0 12px',
    gap: 2,
  },
  navGroup: {
    margin: '0 0 8px 8px',
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.08em',
    color: 'var(--bs-fg-faint)',
  },
  navItem: {
    padding: '7px 12px',
    borderRadius: 6,
    background: 'transparent',
    border: 'none',
    color: 'var(--bs-fg-muted)',
    fontSize: 13,
    fontFamily: 'var(--du-font-sans)',
    textAlign: 'left',
    cursor: 'pointer',
    transition: 'background 100ms ease, color 100ms ease',
  },
  navItemActive: {
    background: 'color-mix(in srgb, var(--bs-orange) 10%, var(--bs-bg-dark))',
    color: 'var(--bs-orange)',
    fontWeight: 600,
  },
  tierCard: {
    margin: '16px 12px 0',
    padding: '14px',
    background: 'var(--bs-bg-dark)',
    border: '1px solid var(--bs-border)',
    borderRadius: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  tierCardLabel: {
    margin: 0,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.1em',
    color: 'var(--bs-fg-faint)',
  },
  tierCardName: {
    margin: 0,
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--bs-fg)',
  },
  tierCardModel: {
    fontWeight: 400,
    color: 'var(--bs-fg-muted)',
  },
  tierCardEffort: {
    margin: 0,
    fontSize: 11,
    color: 'var(--bs-fg-muted)',
  },
  tierCardHint: {
    margin: '4px 0 0',
    fontSize: 11,
    color: 'var(--bs-fg-faint)',
    lineHeight: 1.45,
  },
  main: {
    background: 'var(--bs-bg-dark)',
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
  },
  graphSlot: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  viewPlaceholder: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 40,
  },
  graphPlaceholderText: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--bs-fg)',
  },
  graphPlaceholderSub: {
    margin: 0,
    fontSize: 13,
    color: 'var(--bs-fg-muted)',
    textAlign: 'center',
    maxWidth: 360,
    lineHeight: 1.5,
  },
  rightPanel: {
    background: 'var(--bs-bg)',
    borderLeft: '1px solid var(--bs-border)',
    padding: '20px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    overflow: 'auto',
  },
  panelDivider: {
    height: 1,
    background: 'var(--bs-border)',
    margin: '4px 0',
    flexShrink: 0,
  },
  panelLabel: {
    margin: 0,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.1em',
    color: 'var(--bs-fg-faint)',
  },
  panelPlaceholder: {
    flex: 1,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 24px',
    background: 'var(--bs-bg)',
    borderTop: '1px solid var(--bs-border)',
    flexShrink: 0,
  },
  footerDot: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--bs-green)',
    flexShrink: 0,
  },
  footerText: {
    fontSize: 12,
    color: 'var(--bs-fg-muted)',
  },
}
