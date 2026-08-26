// Code-9ud — FE wrappers for the Intelligent Conductor loop.
// Thin invoke() calls over the conductor_start / conductor_stop Rust commands
// (src-tauri/src/conductor.rs) + the ConductorStatus shape the backend emits on
// the `conductor_status` app event. Status fields match the Rust struct's
// snake_case wire contract (conductor.rs ConductorStatus is un-renamed), so
// they stay snake_case here — same discipline as gateBridge's Gate.

import { invoke } from '@tauri-apps/api/core';

/** Live conductor state, pushed on the `conductor_status` event each pulse. */
export interface ConductorStatus {
  /** "waking" | "awake" | "idle" | "deferred" | "error" | "stopped". */
  state: string;
  bead_id: string | null;
  detail: string | null;
  /** Epoch-ms of the last pulse (u128 on the Rust side). */
  last_pulse_ms: number | null;
  interval_secs: number;
  repo_path: string;
}

/** The app event channel the backend emits ConductorStatus on. */
export const CONDUCTOR_STATUS_EVENT = 'conductor_status';

/**
 * Start the conductor loop for a repo. `dryRun` defaults true (matches the
 * backend default) so a UI toggle never fires real claude pulses until the
 * operator explicitly opts in. Idempotent per repo; replaces on a new repo.
 */
export function conductorStart(
  repoPath: string,
  intervalSecs?: number,
  dryRun = true,
): Promise<void> {
  return invoke<void>('conductor_start', { repoPath, intervalSecs, dryRun });
}

/** Stop the conductor. Halts at the next loop boundary; the in-flight pulse
 *  finishes (its step is durable in bd). Emits a final `stopped` status. */
export function conductorStop(): Promise<void> {
  return invoke<void>('conductor_stop');
}

/**
 * Code-jx3.2 (RV6.2) — fire ONE targeted pulse for `beadId` on demand, bypassing
 * the interval wait but NOT the gate. Runs the same gated body as an interval
 * pulse (bd prime + doctor gate, then advance the bead / fanout if it's an epic).
 *
 * Posture: if a conductor is already running for this repo, the backend INHERITS
 * that loop's dry-run flag (a dry-run loop can't be turned into a live one-shot);
 * `dryRun` here only applies when no loop is running. Defaults true (plan/dry-run).
 */
export function conductorPulseNow(
  repoPath: string,
  beadId: string,
  dryRun = true,
): Promise<void> {
  return invoke<void>('conductor_pulse_now', { repoPath, beadId, dryRun });
}

/**
 * Code-jx3.3 (RV6.3) — stop ONE in-flight builder by bead id. Fires its cancel
 * signal; the builder bails and its claude child is killed. Rejects if nothing is
 * running for that bead (the builder may have just finished). The in-flight bd step
 * is durable, so the next tick re-derives cleanly.
 */
export function conductorStopAgent(beadId: string): Promise<void> {
  return invoke<void>('conductor_stop_agent', { beadId });
}

/**
 * Code-jx3.3 (RV6.3) — defer a bead on demand (`bd defer <id>`). Drops it out of
 * `bd ready` so the conductor skips it next tick. Pure bd write, no cancel handle;
 * leaves bd fully re-derivable.
 */
export function conductorDeferBead(repoPath: string, beadId: string): Promise<void> {
  return invoke<void>('conductor_defer_bead', { repoPath, beadId });
}

/** DU3 (Code-d7j) — the Designer-UI tier modes. Everyday = Sonnet/medium
 *  default, Heavy = Opus/xhigh default. */
export type ConductorTier = 'everyday' | 'heavy';

/**
 * Set the conductor's DEFAULT tier ceiling (the tier an unlabeled bead gets).
 * A per-bead `size:`/`model:` label still overrides this. A running loop picks
 * up the new floor on its next tick — no restart. Returns the resolved tier tag
 * ("S" | "M" | "L").
 */
export function conductorSetDefaultTier(tier: ConductorTier): Promise<string> {
  return invoke<string>('conductor_set_default_tier', { tier });
}
