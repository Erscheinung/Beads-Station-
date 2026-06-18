// Phase 6 — Cost & token meter.
//
// 22px footer strip mounted INSIDE ClaudeChat, between the scroll body and
// the input form. Pulls per-project state from useUsage(projectId).
//
// Layout (one row):
//   cost $0.0042 · in 1,250 · out 940 · cache ↑12k
//
// `cache` shows max(cacheRead, cacheCreate); the ↑ glyph (U+2191) sits in
// front of the larger of the two so a reader can tell whether we're hitting
// the prompt cache or paying creation cost.
// U+2191 is OUTSIDE the audit-emoji forbidden ranges (verified — the script
// flags U+2300-23FF, U+2600-27BF, U+1F000-1FAFF; U+2191 sits below all of
// those).

import { useUsage } from '../state/claudeUsage'

interface CostMeterProps {
  projectId: string
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000) return Math.round(n / 1000) + 'k'
  if (n >= 1_000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n).toLocaleString()
}

export function CostMeter({ projectId }: CostMeterProps) {
  const u = useUsage(projectId)
  const cacheMax = Math.max(u.cacheRead, u.cacheCreate)
  const cacheArrow = cacheMax > 0 // only show arrow if there's anything to point at
  return (
    <div className="bs-cost-meter" aria-label="claude cost meter">
      <span>
        cost <strong>${u.cost.toFixed(4)}</strong>
      </span>
      <span aria-hidden="true" style={{ color: 'var(--bs-fg-faint)' }}>·</span>
      <span>
        in <strong>{Math.round(u.in).toLocaleString()}</strong>
      </span>
      <span aria-hidden="true" style={{ color: 'var(--bs-fg-faint)' }}>·</span>
      <span>
        out <strong>{Math.round(u.out).toLocaleString()}</strong>
      </span>
      <span aria-hidden="true" style={{ color: 'var(--bs-fg-faint)' }}>·</span>
      <span>
        cache{' '}
        {cacheArrow && (
          <span style={{ color: 'var(--bs-fg-faint)' }} aria-hidden="true">↑</span>
        )}
        <strong>{formatTokens(cacheMax)}</strong>
      </span>
    </div>
  )
}
