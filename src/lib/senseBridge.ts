// RV5.1 (Code-qqa) — FE wrappers for the Obsidian sensor / wisp verbs.
// Thin invoke() calls over the sense_* Rust commands. The Wisp shape matches
// bd's snake_case JSON (the Rust struct is un-renamed), so fields stay
// snake_case here too — same convention as gateBridge.ts.

import { invoke } from '@tauri-apps/api/core';

export interface Wisp {
  id: string;
  title: string;
  description: string | null;
  status: string;
  created_at: string;
  /** Vault-relative source path parsed from the `sense:src=` label. */
  source: string | null;
}

/** Open ephemeral wisps — the sensed files awaiting a promote/dismiss decision. */
export function senseList(repoPath: string): Promise<Wisp[]> {
  return invoke<Wisp[]>('sense_list', { repoPath });
}

/** Promote: copy the wisp into the permanent issues table (`bd promote`). */
export function sensePromote(repoPath: string, id: string): Promise<void> {
  return invoke<void>('sense_promote', { repoPath, id });
}

/** Dismiss: close the wisp without promoting (`bd close`). */
export function senseDismiss(repoPath: string, id: string): Promise<void> {
  return invoke<void>('sense_dismiss', { repoPath, id });
}

/** Scan the watched Obsidian folders; mint a wisp per unseen `.md`. Returns count. */
export function senseScan(repoPath: string): Promise<number> {
  return invoke<number>('sense_scan', { repoPath });
}

/** Start the sensor watchers on the vault folders (Rust owns the paths); emits
 * `sense_changed` on `.md` churn. */
export function senseWatchStart(): Promise<void> {
  return invoke<void>('sense_watch_start', { dirs: [] });
}

/** Stop the sensor watchers. */
export function senseWatchStop(): Promise<void> {
  return invoke<void>('sense_watch_stop');
}
