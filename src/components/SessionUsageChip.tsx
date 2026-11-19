// Live usage of the agent session running in a pane: context use, its size
// and subagents, from the CLI's status line and its own session file
// (src/state/paneUsage.ts). It starts nothing and needs no tokens. Hidden
// while nothing is known.

import { usePaneUsage, usageChipText, usageTooltip } from '../state/paneUsage'

export function SessionUsageChip({ paneId }: { paneId: string }) {
  const usage = usePaneUsage(paneId)
  const text = usageChipText(usage)
  if (!usage || !text) return null
  return <span className="bs-session-usage" data-testid="session-usage" data-provider={usage.provider} title={usageTooltip(usage)}>{text}</span>
}
