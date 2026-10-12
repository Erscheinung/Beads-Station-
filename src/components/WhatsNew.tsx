import { useEffect, useState } from 'react'
import { markVersionSeen, unseenHighlights } from '../state/whatsNew'

/** Shown once, on the first launch after an update. */
export function WhatsNew() {
  // The browser test harness seeds settings on every run, which would read as an upgrade.
  const [releases, setReleases] = useState(() => import.meta.env.VITE_LIVE_MOCK ? [] : unseenHighlights())
  const open = releases.length > 0

  useEffect(() => {
    if (!open) { markVersionSeen(); return }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Enter') return
      event.preventDefault()
      event.stopPropagation()
      markVersionSeen()
      setReleases([])
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open) return null
  return <div className="bs-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="bs-whats-new-title">
    <div className="bs-modal-card" style={{ maxWidth: 560 }}>
      <h2 className="bs-modal-title" id="bs-whats-new-title">What’s new in Beads Station</h2>
      {releases.map(release => <section key={release.version}>
        <h3 style={{ fontSize: 12, margin: '12px 0 6px', color: 'var(--bs-fg-muted)' }}>{release.version}</h3>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.6, color: 'var(--bs-fg)' }}>
          {release.items.map(item => <li key={item}>{item}</li>)}
        </ul>
      </section>)}
      <div className="bs-modal-actions" style={{ marginTop: 16 }}>
        <button autoFocus type="button" className="bs-modal-btn bs-modal-btn--primary" onClick={() => { markVersionSeen(); setReleases([]) }}>Got it <kbd aria-hidden>↵</kbd></button>
      </div>
    </div>
  </div>
}
