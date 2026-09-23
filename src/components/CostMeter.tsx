// Phase 6 — Cost & token meter.
//
// 22px footer strip mounted INSIDE ClaudeChat, between the scroll body and
// the input form. Pulls per-project state from useUsage(projectId).
//
// Layout (one row):
//   cost $0.0042 · in 1,250 · out 940 · cache ↑12k        day 4.79/50 · mo 114/500
//
// `cache` shows max(cacheRead, cacheCreate); the ↑ glyph (U+2191) sits in
// front of the larger of the two so a reader can tell whether we're hitting
// the prompt cache or paying creation cost.
// U+2191 is OUTSIDE the audit-emoji forbidden ranges (verified — the script
// flags U+2300-23FF, U+2600-27BF, U+1F000-1FAFF; U+2191 sits below all of
// those).
//
// Code-9d8: the right-aligned `day X/limit · mo Y/limit` group is the optional
// LLM gateway daily/monthly EUR spend aggregate. It comes from the
// `gateway_spending` Tauri command (reads the cached Bearer token named by
// BS_GATEWAY_SPEND_TOKEN_FILE and calls BS_GATEWAY_SPEND_URL). It is omitted
// entirely when unconfigured or unavailable (no valid token, offline) so the
// per-session USD meter on the left always stands alone.

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useUsage } from '../state/claudeUsage'

interface CostMeterProps {
  projectId: string
}

interface GatewaySpend {
  available: boolean
  dailyEur: number
  monthlyEur: number
  dailyLimitEur: number
  monthlyLimitEur: number
  plan: string
}

// Gateways typically refresh caps/costs on a ~3600s server interval, so a
// tight poll would be wasted work. Refetch on mount and every 5 minutes; the
// numbers move slowly. Shared across CostMeter instances would be ideal, but a
// per-pane poll every 5m is cheap enough and keeps this component self-contained.
const POLL_MS = 5 * 60 * 1000

function useGatewaySpend(): GatewaySpend | null {
  const [spend, setSpend] = useState<GatewaySpend | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => {
      invoke<GatewaySpend>('gateway_spending')
        .then(s => { if (alive) setSpend(s) })
        .catch(() => { if (alive) setSpend(null) })
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return spend
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000) return Math.round(n / 1000) + 'k'
  if (n >= 1_000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n).toLocaleString()
}

// EUR values: whole-euro when >= 10 to keep the strip narrow, else 2dp.
function formatEur(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return n >= 10 ? Math.round(n).toString() : n.toFixed(2)
}

export function CostMeter({ projectId }: CostMeterProps) {
  const u = useUsage(projectId)
  const spend = useGatewaySpend()
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
      {spend?.available && (
        <span
          className="bs-cost-meter-aggregate"
          title={`Gateway spend${spend.plan ? ` (${spend.plan})` : ''}`}
        >
          <span>
            day <strong>{formatEur(spend.dailyEur)}</strong>/{formatEur(spend.dailyLimitEur)}€
          </span>
          <span aria-hidden="true" style={{ color: 'var(--bs-fg-faint)' }}>·</span>
          <span>
            mo <strong>{formatEur(spend.monthlyEur)}</strong>/{formatEur(spend.monthlyLimitEur)}€
          </span>
        </span>
      )}
    </div>
  )
}
