import { bdInitialize, type BdInitReport } from '../types/issue'
import { invalidate } from './bdCache'

const inFlight = new Map<string, Promise<BdInitReport>>()

/**
 * Share one explicit initialization attempt per canonical workspace. Empty
 * states can be mounted twice (Board + Explorer), and a rapid double click
 * must still produce one backend action. The backend remains the authority on
 * canonicalization and safety; this map only coalesces the UI intent.
 */
export function initializeBeads(repoPath: string): Promise<BdInitReport> {
  const existing = inFlight.get(repoPath)
  if (existing) return existing
  const attempt = bdInitialize(repoPath)
    .then(report => {
      // The backend has already verified the resulting store. Refetching here
      // lets every mounted consumer converge through the shared cache.
      invalidate(repoPath)
      return report
    })
    .finally(() => {
      if (inFlight.get(repoPath) === attempt) inFlight.delete(repoPath)
    })
  inFlight.set(repoPath, attempt)
  return attempt
}

export type BeadsInitErrorKind = 'missing_bd' | 'permission' | 'corrupt' | 'failure'

export function classifyBeadsInitError(error: unknown): BeadsInitErrorKind {
  const text = String(error).toLowerCase()
  if (text.includes('missing_bd') || text.includes('failed to spawn bd') || text.includes('resolve bd')) return 'missing_bd'
  if (text.includes('permission') || text.includes('not permitted') || text.includes('read-only')) return 'permission'
  if (text.includes('corrupt') || text.includes('malformed') || text.includes('schema') || text.includes('parse')) return 'corrupt'
  return 'failure'
}

export function beadsInitErrorMessage(error: unknown): string {
  switch (classifyBeadsInitError(error)) {
    case 'missing_bd':
      return 'The bd CLI is not installed or is not available to Beads Station. Install bd, then try again.'
    case 'permission':
      return 'Beads Station could not write this workspace. Check folder permissions or choose another workspace.'
    case 'corrupt':
      return 'An existing Beads store or export could not be verified. No reinitialization was attempted.'
    default:
      return `Beads initialization failed: ${String(error)}`
  }
}

/** Test seam: failed or completed attempts should not leak between cases. */
export function __resetBeadsInitForTest(): void {
  inFlight.clear()
}
