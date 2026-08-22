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
