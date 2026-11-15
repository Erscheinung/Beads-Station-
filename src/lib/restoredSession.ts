// Which conversation a restored agent pane most likely held, when the pane
// never learned its session id (an older build, or a CLI that did not report).
// This only chooses what to SHOW; the user sees it before continuing it.

export interface SessionCandidate {
  id: string
  provider: string
  modifiedMs: number
}

/** The screen is captured occasionally, so the session may be a little newer than it. */
const CAPTURE_SLACK_MS = 10 * 60_000

/**
 * The newest session of that CLI in the folder that no other pane claims and
 * that was last written before the pane's screen was saved. Without a capture
 * time, the newest unclaimed one. Null when nothing fits: never a guess across
 * providers.
 */
export function recoverSession<T extends SessionCandidate>(
  summaries: readonly T[],
  provider: string,
  capturedAt: number | null | undefined,
  claimed: ReadonlySet<string> = new Set(),
): T | null {
  const limit = typeof capturedAt === 'number' && capturedAt > CAPTURE_SLACK_MS ? capturedAt + CAPTURE_SLACK_MS : Infinity
  let best: T | null = null
  for (const summary of summaries) {
    if (summary.provider !== provider || claimed.has(summary.id) || summary.modifiedMs > limit) continue
    if (!best || summary.modifiedMs > best.modifiedMs) best = summary
  }
  return best
}
