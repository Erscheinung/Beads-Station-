import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import '../../theme/designer-light.css'
import { BeadGraph } from './BeadGraph'
import { GateCockpit } from './GateCockpit'
import { SensorsPanel } from './SensorsPanel'
import { ConductorControl } from './ConductorControl'
import { ActiveAgents } from './ActiveAgents'
import { Timeline } from './Timeline'
import { DesignerEmptyState } from './DesignerEmptyState'
import { ColumnResizer } from './ColumnResizer'
import { loadDesignerLayout, saveDesignerLayout, type DesignerLayout } from './designerLayout'
import { useProjects } from '../../state/projects'
import { setSkin } from '../../state/skin'
import { conductorSetDefaultTier } from '../../lib/conductorBridge'
import { useConductorStatus, statusPresentation } from '../../lib/useConductorStatus'
import { bdCreate, bdNote, type Issue } from '../../types/issue'
import { cancelNativeRun, reconcileNativeRuns, startNativeRun, useNativeRun, type NativeProvider } from './nativeRuns'
import { approveArtifact, captureArtifact, requestArtifactChanges, useArtifactReview, type ArtifactRevision } from './artifacts'
import { openPalette } from '../../state/palette'
import { openSettings } from '../../state/settings'

type Tier = 'everyday' | 'heavy'
type NavItem = 'requests' | 'graph' | 'agents' | 'timeline'
interface ProviderAvailability {
  provider: NativeProvider
  available: boolean
  detail: string
}

const NAV_ITEMS: { id: NavItem; label: string }[] = [
  { id: 'requests', label: 'Requests' },
  { id: 'graph',    label: 'Bead graph' },
  { id: 'agents',   label: 'Agents' },
  { id: 'timeline', label: 'Timeline' },
]

// Code-da0.5 — direct provider CLIs and conductor backends for ticket runs.
const RUN_OPTIONS: { value: NativeProvider; label: string }[] = [
  { value: 'claude', label: 'Claude (native login)' },
  { value: 'codex', label: 'Codex (native login)' },
  { value: 'codex-orchestrator', label: 'Codex orchestrator (Sol + Luna)' },
  { value: 'opus-conductor', label: 'Opus conductor (placeholder)' },
]

const TIER_META = {
  everyday: { model: 'standard routing', effort: 'Provider decides model and effort', heavy: 'Switch to Heavy to request more capable routing for difficult work.' },
  heavy:    { model: 'heavy routing', effort: 'Provider decides model and effort', heavy: 'Heavy is a routing preference, not a claim about the model that ran.' },
}

export function DesignerShell() {
  const [tier, setTier] = useState<Tier>('everyday')
  const [nav, setNav]   = useState<NavItem>('requests')
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null)
  const [layout, setLayout] = useState<DesignerLayout>(loadDesignerLayout)
  const resizeColumn = useCallback((side: keyof DesignerLayout, width: number) => {
    setLayout(current => (current[side] === width ? current : { ...current, [side]: width }))
  }, [])
  const commitColumn = useCallback((side: keyof DesignerLayout, width: number) => {
    setLayout(current => {
      const next = { ...current, [side]: width }
      saveDesignerLayout(next)
      return next
    })
  }, [])

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
    <div className="bs-designer" style={styles.root}>
      {/* ── Top bar ── */}
      <header style={styles.topbar}>
        <div style={styles.wordmark}>
          <span style={styles.dot} />
          <span style={styles.wordmarkText}>Beads Station</span>
        </div>
        <div style={styles.topbarRight}>
          <button style={styles.skinBtn} onClick={() => window.dispatchEvent(new Event('workspace:open'))}>Open workspace</button>
          <button style={styles.skinBtn} onClick={openPalette}>Commands</button>
          <button style={styles.skinBtn} onClick={openSettings}>Settings</button>
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
      <div style={{ ...styles.body, gridTemplateColumns: `${layout.left}px 1fr ${layout.right}px` }}>
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

        <div style={{ ...styles.resizerSlot, left: layout.left - 3 }}>
          <ColumnResizer
            side="left"
            width={layout.left}
            label="Resize navigation column"
            onResize={width => resizeColumn('left', width)}
            onCommit={width => commitColumn('left', width)}
          />
        </div>
        <div style={{ ...styles.resizerSlot, right: layout.right - 3 }}>
          <ColumnResizer
            side="right"
            width={layout.right}
            label="Resize gates and agents panel"
            onResize={width => resizeColumn('right', width)}
            onCommit={width => commitColumn('right', width)}
          />
        </div>

        {/* Center — main view */}
        <main style={styles.main}>
          <CenterView nav={nav} selectedIssue={selectedIssue} onSelectIssue={setSelectedIssue} />
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

function CenterView({ nav, selectedIssue, onSelectIssue }: {
  nav: NavItem
  selectedIssue: Issue | null
  onSelectIssue: (issue: Issue | null) => void
}) {
  if (nav === 'requests' || nav === 'graph') {
    return (
      <div id="du-bead-graph" style={styles.graphSlot}>
        {selectedIssue
          ? <TicketRun issue={selectedIssue} onBack={() => onSelectIssue(null)} />
          : nav === 'requests'
            ? <RequestBrowser onSelect={onSelectIssue} />
            : <BeadGraph onSelect={onSelectIssue} />}
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

function RequestBrowser({ onSelect }: { onSelect: (issue: Issue) => void }) {
  const { projects, activeId } = useProjects()
  const project = projects.find(p => p.id === activeId) ?? projects[0] ?? null
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [context, setContext] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    if (!project || !title.trim()) return
    setError(null)
    try {
      const id = await bdCreate(project.path, title.trim())
      if (context.trim()) await bdNote(project.path, id, `Designer request context:\n${context.trim()}`)
      setTitle(''); setContext(''); setCreating(false)
    } catch (e) { setError(String(e)) }
  }
  return <div style={styles.requestBrowser}>
    <div style={styles.requestBrowserHeader}>
      <div><h2 style={styles.requestTitle}>Requests</h2><p style={styles.requestMeta}>Choose a ready request or capture a new outcome.</p></div>
      <button style={styles.primaryBtn} onClick={() => setCreating(v => !v)}>New request</button>
    </div>
    {creating && <div style={styles.reviewBox}>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="What outcome do you need?" style={styles.providerSelect} />
      <textarea value={context} onChange={e => setContext(e.target.value)} placeholder="Context, constraints, acceptance criteria, references" style={styles.feedback} />
      {error && <span style={{ color: 'var(--bs-red)' }}>{error}</span>}
      <button style={styles.primaryBtn} disabled={!title.trim()} onClick={create}>Create request</button>
    </div>}
    <div className="du-request-graph" style={{ flex: 1, minHeight: 0 }}><BeadGraph onSelect={onSelect} /></div>
  </div>
}

function TicketRun({ issue, onBack }: { issue: Issue; onBack: () => void }) {
  const { projects, activeId } = useProjects()
  const project = projects.find(p => p.id === activeId) ?? projects[0] ?? null
  const [provider, setProvider] = useState<NativeProvider>('claude')
  const [providers, setProviders] = useState<ProviderAvailability[]>([])
  const [feedback, setFeedback] = useState('')
  const [artifactBusy, setArtifactBusy] = useState(false)
  const [artifactError, setArtifactError] = useState<string | null>(null)
  const runKey = `${project?.id ?? 'missing'}:${issue.id}`
  const run = useNativeRun(runKey, project?.id ?? 'missing', issue.id)
  const { status, output } = run
  const artifactIdentity = {
    workspaceId: run.workspaceId,
    ticketId: run.ticketId,
    runId: run.runId ?? '',
    attemptId: run.attemptId ?? '',
  }
  const review = useArtifactReview(artifactIdentity, status)
  const availability = providers.find(p => p.provider === provider)
  const prompt = useMemo(() => [
    `Work on ticket ${issue.id}: ${issue.title}`,
    issue.description ? `Request context:\n${issue.description}` : 'No additional description was provided.',
    issue.acceptance_criteria ? `Acceptance criteria:\n${issue.acceptance_criteria}` : '',
    issue.notes ? `Notes:\n${issue.notes}` : '',
    'Keep the work scoped to this ticket. Run relevant checks and report changed files, evidence, and limitations.',
    // Approval binds to this run's captured revision, so the agent must not
    // close the ticket ahead of the requester's review.
    'Do not close or mark the ticket done; the requester reviews and approves the result in Beads Station.',
  ].filter(Boolean).join('\n\n'), [issue])

  useEffect(() => {
    invoke<ProviderAvailability[]>('native_provider_status', { cwd: project?.path ?? null }).then(value => setProviders(Array.isArray(value) ? value : [])).catch(error => {
      setProviders(RUN_OPTIONS.map(option => ({ provider: option.value, available: false, detail: String(error) })))
    })
  }, [project?.path])

  const start = async (revisionFeedback?: string) => {
    if (!project || availability?.available !== true || status === 'starting' || status === 'running' || status === 'unknown') return
    const attemptId = crypto.randomUUID()
    const nextRunId = `${project.id}:${issue.id}:${attemptId}`
    await startNativeRun(runKey, {
        runId: nextRunId,
        workspaceId: project.id,
        ticketId: issue.id,
        attemptId,
        provider,
        cwd: project.path,
        prompt: revisionFeedback ? `${prompt}\n\nRequested revision:\n${revisionFeedback}` : prompt,
    })
  }

  const cancel = async () => {
    await cancelNativeRun(runKey)
  }

  const capture = async () => {
    if (!project || status !== 'needs_review' || !run.runId || !run.attemptId) return
    setArtifactBusy(true); setArtifactError(null)
    try { await captureArtifact(artifactIdentity, run.cwd || project.path) }
    catch (error) { setArtifactError(String(error)) }
    finally { setArtifactBusy(false) }
  }

  const approve = async () => {
    if (!review.revision) return
    setArtifactBusy(true); setArtifactError(null)
    try { await approveArtifact(review.revision, status) }
    catch (error) { setArtifactError(String(error)) }
    finally { setArtifactBusy(false) }
  }

  const requestChanges = () => {
    const text = feedback.trim()
    if (!text || !run.runId || !run.attemptId) return
    try {
      requestArtifactChanges(artifactIdentity, text)
      setFeedback('')
      setArtifactError(null)
      void start(text)
    } catch (error) { setArtifactError(String(error)) }
  }

  return (
    <section style={styles.requestDetail} data-testid="designer-ticket-run">
      <button style={styles.skinBtn} onClick={onBack}>← Back to requests</button>
      <div>
        <p style={styles.requestEyebrow}>REQUEST · {issue.id}</p>
        <h2 style={styles.requestTitle}>{issue.title}</h2>
        <p className="du-request-body" style={styles.requestBody}>{issue.description || 'No additional request context was provided.'}</p>
      </div>
      <div style={styles.providerRow}>
        <label htmlFor="designer-provider">Run with</label>
        <select id="designer-provider" disabled={status === 'running' || status === 'starting'} value={status === 'running' || status === 'starting' ? run.provider : provider} onChange={e => setProvider(e.target.value as NativeProvider)} style={styles.providerSelect}>
          {RUN_OPTIONS.map(option => {
            const known = providers.find(p => p.provider === option.value)
            return <option key={option.value} value={option.value} disabled={known ? !known.available : false}>{option.label}</option>
          })}
        </select>
        <span style={styles.requestMeta}>{availability?.detail ?? 'Checking installation…'}</span>
        <span style={styles.requestMeta}>Effective model and usage: unknown until reported by the CLI.</span>
      </div>
      <div style={styles.runActions}>
        <button style={styles.primaryBtn} disabled={!availability?.available || status === 'running' || status === 'starting' || status === 'unknown'} onClick={() => start()}>
          {status === 'idle' ? 'Start work' : status === 'failed' || status === 'cancelled' ? 'Try again' : 'Run started'}
        </button>
        {(status === 'running' || status === 'unknown') && <button style={styles.skinBtn} onClick={() => void reconcileNativeRuns(project?.id ?? 'missing')}>Check run status</button>}
        {(status === 'running' || status === 'starting' || status === 'unknown') && run.runId && <button style={styles.skinBtn} onClick={cancel}>Cancel</button>}
        <span style={styles.requestMeta}>Status: {status.replace('_', ' ')}</span>
      </div>
      {status === 'unknown' && <span style={styles.requestMeta}>Backend state unavailable; no new run will start automatically.</span>}
      <div style={styles.runOutput} aria-live="polite">
        {output.length === 0 ? 'Provider output will appear here. No work starts until you choose Start work.' : output.map((line, i) => <p key={i}>{line}</p>)}
      </div>
      {status === 'needs_review' && <div style={styles.reviewBox}>
        <strong>Run finished; review is required.</strong>
        <span>Approval is available only for this exact run and an immutable workspace capture. Completion has not been claimed.</span>
        <div style={styles.runActions}>
          <button style={styles.skinBtn} disabled={artifactBusy || Boolean(review.approval)} onClick={() => void capture()}>{artifactBusy ? 'Capturing…' : review.revision ? 'Recapture artifact' : 'Capture artifact'}</button>
          <button style={styles.primaryBtn} disabled={artifactBusy || !review.revision || Boolean(review.approval)} onClick={() => void approve()}>{review.approval ? 'Approved exact revision' : 'Approve revision'}</button>
        </div>
        {review.revision && <ArtifactReview revision={review.revision} approval={Boolean(review.approval)} />}
        {review.feedback.length > 0 && <div style={styles.feedbackHistory}><strong>Revision feedback</strong>{review.feedback.map(item => <p key={item.feedbackId}>{item.text}</p>)}</div>}
        <textarea value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Describe what should change" style={styles.feedback} />
        <button style={styles.skinBtn} disabled={!feedback.trim() || artifactBusy} onClick={requestChanges}>Request changes</button>
        {artifactError && <span style={{ color: 'var(--bs-red)' }}>{artifactError}</span>}
      </div>}
    </section>
  )
}

function ArtifactReview({ revision, approval }: { revision: ArtifactRevision; approval: boolean }) {
  return <div style={styles.artifactReview} data-testid="designer-artifact-review">
    <div style={styles.artifactHeader}><strong>Artifact revision {revision.revisionId}</strong><span style={styles.requestMeta}>hash {revision.revisionHash}</span>{approval && <span style={{ color: 'var(--bs-green)' }}>Approved</span>}</div>
    <p style={styles.requestMeta}>Captured {new Date(revision.capturedAt).toLocaleString()} · {revision.files.length} changed file{revision.files.length === 1 ? '' : 's'}{revision.sourceRevision ? ` · source ${revision.sourceRevision.slice(0, 12)}` : ''}</p>
    <ul style={styles.artifactManifest}>{revision.files.map(file => <li key={file.path}><code>{file.status || 'changed'}</code> <span>{file.path}</span>{file.truncated && <em> (preview truncated)</em>}</li>)}</ul>
    <div style={styles.validationList}><strong>Validation evidence</strong>{revision.validation.length > 0 ? revision.validation.map((item, index) => <span key={index}>{item}</span>) : <span>No independent checks were captured for this revision.</span>}</div>
    {revision.diff && <details><summary>Diff preview</summary><pre style={styles.artifactPreview}>{revision.diff}</pre></details>}
    {!revision.diff && revision.files.map(file => file.content != null && <details key={file.path}><summary>{file.path} preview{file.binary ? ' (binary)' : ''}</summary><pre style={styles.artifactPreview}>{file.content}</pre></details>)}
  </div>
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
    position: 'relative',
  },
  resizerSlot: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 6,
    zIndex: 5,
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
  requestDetail: { display: 'flex', flexDirection: 'column', gap: 20, padding: 28, maxWidth: 900, width: '100%', margin: '0 auto', boxSizing: 'border-box' },
  requestBrowser: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  requestBrowserHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 8px' },
  requestEyebrow: { margin: '0 0 6px', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--bs-orange)' },
  requestTitle: { margin: 0, fontSize: 24, color: 'var(--bs-fg)' },
  requestBody: { margin: '10px 0 0', whiteSpace: 'pre-wrap', lineHeight: 1.6, color: 'var(--bs-fg-muted)' },
  requestMeta: { fontSize: 12, color: 'var(--bs-fg-muted)' },
  providerRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  providerSelect: { padding: '7px 10px', borderRadius: 7, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg)' },
  runActions: { display: 'flex', alignItems: 'center', gap: 10 },
  primaryBtn: { padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--bs-orange)', color: '#fff', fontWeight: 600, cursor: 'pointer' },
  runOutput: { minHeight: 160, maxHeight: 360, overflow: 'auto', padding: 16, borderRadius: 10, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg-muted)', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.55 },
  reviewBox: { display: 'flex', flexDirection: 'column', gap: 10, padding: 16, borderRadius: 10, border: '1px solid var(--bs-yellow)', color: 'var(--bs-fg)' },
  feedback: { minHeight: 72, padding: 10, borderRadius: 7, border: '1px solid var(--bs-border)', background: 'var(--bs-bg)', color: 'var(--bs-fg)', fontFamily: 'var(--du-font-sans)', resize: 'vertical' },
  artifactReview: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 8, border: '1px solid var(--bs-border)', background: 'var(--bs-bg-dark)' },
  artifactHeader: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  artifactManifest: { margin: 0, paddingLeft: 20, maxHeight: 160, overflow: 'auto', fontSize: 12, lineHeight: 1.5 },
  artifactPreview: { maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '8px 0 0', padding: 10, borderRadius: 6, background: 'var(--bs-bg)', color: 'var(--bs-fg-muted)', fontSize: 11 },
  validationList: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: 'var(--bs-fg-muted)' },
  feedbackHistory: { display: 'flex', flexDirection: 'column', gap: 4, padding: 8, borderLeft: '2px solid var(--bs-border)', color: 'var(--bs-fg-muted)', fontSize: 12 },
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
