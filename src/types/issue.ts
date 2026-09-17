// TypeScript mirror of the Rust `Issue` struct in src-tauri/src/bd.rs.
// Field names are snake_case to match bd's JSON output (no camelCase
// translation in serde, so the wire format flows through unchanged).
//
// R3: every `invoke("bd_*")` here now routes through `safeInvoke`. Reads and
// mutations pass { rethrow: true } so the caller's own logic (Board rollback,
// IssueList error state) still runs — the toast fires first, then the error
// propagates. This keeps working error handling intact while guaranteeing no
// failure is silent (the "silent no-op" class the audit found on bd_close).

import { safeInvoke } from '../lib/invokeErrorBoundary';

export interface Issue {
  id: string;
  title: string;
  description: string | null;
  notes?: string | null;
  acceptance_criteria?: string | null;
  status: string;
  priority: number;
  issue_type: string;
  assignee: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  dependency_count: number;
  dependent_count: number;
  comment_count: number;
  labels: string[] | null;
  parent: string | null;
  dependencies: Dependency[];
}

/** A bd dependency edge: `depends_on_id` blocks `issue_id`. */
export interface Dependency {
  issue_id: string;
  depends_on_id: string;
  type: string;
}

/** `bd ready --json` — issues with no open blockers. */
export async function bdReady(repoPath: string): Promise<Issue[]> {
  const r = (await safeInvoke<Issue[]>('bd_ready', { repoPath }, { rethrow: true }))!;
  // RV3.2 debug — trace bd read returns to the Web Inspector console so an
  // empty/degraded result is visible against the Statusline's live count.
  console.debug('[bd] bdReady', repoPath, '→', r.length);
  return r;
}

/** `bd show <id> --json --long` — full issue detail. */
export async function bdShow(repoPath: string, id: string): Promise<Issue> {
  return (await safeInvoke<Issue>('bd_show', { repoPath, id }, { rethrow: true }))!;
}

/**
 * `bd list --json [--status <filter>]`.
 * Pass `null`/`undefined` to list all statuses.
 */
export async function bdList(
  repoPath: string,
  statusFilter?: string | null,
): Promise<Issue[]> {
  const r = (await safeInvoke<Issue[]>(
    'bd_list',
    { repoPath, statusFilter: statusFilter ?? null },
    { rethrow: true },
  ))!;
  console.debug('[bd] bdList', repoPath, statusFilter ?? 'all', '→', r.length);
  return r;
}

/** RV3.3 — `bd_snapshot`: one round-trip returning `ready` + `all` so a single
 * shared fetch feeds Board, IssueList, and Statusline (see lib/bdCache.ts). */
export interface BdSnapshotData {
  ready: Issue[];
  all: Issue[];
  /** RV3.7 (Code-hc9) — true only when bd classified the read as NoDatabase
   * (no `.beads/` db). Lets the FE distinguish a real missing-db repo from a
   * genuinely-empty one; both otherwise arrive as ready:[] all:[]. */
  no_db: boolean;
}

export interface BdInitReport {
  outcome: 'initialized' | 'bootstrapped' | 'already_exists'
  target: string
  command: string
  message: string
}

/** Intent-only `bd init`/`bd bootstrap` wrapper. The backend refuses to
 * reinitialize an existing store and verifies the result before resolving. */
export async function bdInitialize(repoPath: string): Promise<BdInitReport> {
  return (await safeInvoke<BdInitReport>(
    'bd_initialize',
    { repoPath },
    { rethrow: true },
  ))!
}

export async function bdSnapshot(repoPath: string): Promise<BdSnapshotData> {
  const r = (await safeInvoke<BdSnapshotData>(
    'bd_snapshot',
    { repoPath },
    { rethrow: true },
  ))!;
  console.debug('[bd] bdSnapshot', repoPath, '→ ready', r.ready.length, 'all', r.all.length);
  return r;
}

// ---------------------------------------------------------------------------
// Mutations — Phase 3.
//
// These wrap the Rust `bd_*` commands that mutate issue state. They all
// resolve to void on success and reject with a String error otherwise. Names
// follow camelCase on the JS side; the underlying Tauri commands are
// snake_case (`bd_claim`, `bd_set_status`, …).
//
// R3: all mutations pass { rethrow: true } so Board.tsx's optimistic-rollback
// catch still fires. The toast surfaces the raw error regardless.
//
// Note: the close wrapper is named `bdCloseIssue` to avoid colliding with
// the tab-close metaphor used in the UI layer.
// ---------------------------------------------------------------------------

/** `bd update <id> --claim` — assigns the issue to the current user and flips status to in_progress. */
export async function bdClaim(repoPath: string, id: string): Promise<void> {
  await safeInvoke<void>('bd_claim', { repoPath, id }, { rethrow: true });
}

/** `bd create <title> -t task -p <priority>` — Phase 9 palette "New issue".
 *  Returns the new issue id. `priority` defaults to "2" backend-side. */
export async function bdCreate(
  repoPath: string,
  title: string,
  priority?: string,
): Promise<string> {
  return (await safeInvoke<string>(
    'bd_create',
    { repoPath, title, priority: priority ?? null },
    { rethrow: true },
  ))!;
}

/** `bd update <id> --status <status>` — set the issue status to one of open/in_progress/blocked/closed. */
export async function bdSetStatus(
  repoPath: string,
  id: string,
  status: string,
): Promise<void> {
  await safeInvoke<void>('bd_set_status', { repoPath, id, status }, { rethrow: true });
}

/**
 * `bd close <id> [--reason ...]` — closes an issue with an optional close reason.
 * R3: the Rust command now accepts `reason: Option<String>`, so passing `null`
 * (the "close without note" path) is a valid default-reason close rather than
 * a serde-reject silent no-op.
 */
export async function bdCloseIssue(
  repoPath: string,
  id: string,
  reason?: string | null,
): Promise<void> {
  await safeInvoke<void>('bd_close', { repoPath, id, reason: reason ?? null }, { rethrow: true });
}

/** `bd label add <id> <label>` — attach a label. */
export async function bdAddLabel(
  repoPath: string,
  id: string,
  label: string,
): Promise<void> {
  await safeInvoke<void>('bd_add_label', { repoPath, id, label }, { rethrow: true });
}

/** `bd label remove <id> <label>` — detach a label. */
export async function bdRemoveLabel(
  repoPath: string,
  id: string,
  label: string,
): Promise<void> {
  await safeInvoke<void>('bd_remove_label', { repoPath, id, label }, { rethrow: true });
}

/** `bd note add <id> <text>` — append a note/comment to an issue. */
export async function bdNote(
  repoPath: string,
  id: string,
  text: string,
): Promise<void> {
  await safeInvoke<void>('bd_note', { repoPath, id, text }, { rethrow: true });
}
