// RV5.0 (Code-ew0) — FE wrappers for the bd gate cockpit.
// Thin invoke() calls over the bd_gate_* Rust commands. The Gate shape matches
// bd's snake_case JSON (the Rust struct is un-renamed), so fields stay
// snake_case here too.

import { invoke } from '@tauri-apps/api/core';

export interface Gate {
  id: string;
  title: string;
  description: string | null;
  status: string;
  /** bd gate kind: "human" | "timer" | "gh:run" | "gh:pr" | "bead". */
  await_type: string;
  is_template: boolean;
  created_at: string;
}

/** Open, human, non-template gates — the ones a human resolves in the cockpit. */
export function gateList(repoPath: string): Promise<Gate[]> {
  return invoke<Gate[]>('bd_gate_list', { repoPath });
}

/** Approve: resolve (close) a human gate so its blocked step proceeds. */
export function gateResolve(repoPath: string, id: string): Promise<void> {
  return invoke<void>('bd_gate_resolve', { repoPath, id });
}
