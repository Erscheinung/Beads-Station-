// Phase 7 (Code-ky4.7) — FE wrapper for the daily.rs Obsidian writer.
// Thin invoke() call; the backend owns the vault path + local-time stamping.
// The manual "Save Update" command and any future morning/quit triggers route
// through here.

import { invoke } from '@tauri-apps/api/core';

export interface DailyWrite {
  /** Absolute path to the daily file that was written. */
  path: string;
  /** The YYYY-MM-DD date key the file is named for. */
  date: string;
  /** True when this call created the file (wrote the H1 header). */
  created: boolean;
}

/**
 * Append a `## HH:MM — <title>` subsection to today's daily log, creating the
 * file with its H1 if absent. `dirOverride` is for tests/alternate vaults; the
 * real vault path is resolved backend-side when omitted.
 */
export function dailyAppend(
  title: string,
  body: string,
  dirOverride?: string,
): Promise<DailyWrite> {
  return invoke<DailyWrite>('daily_append', {
    title,
    body,
    dirOverride: dirOverride ?? null,
  });
}
