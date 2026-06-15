// TypeScript mirror of the Rust `Issue` struct in src-tauri/src/bd.rs.
// Field names are snake_case to match bd's JSON output (no camelCase
// translation in serde, so the wire format flows through unchanged).

export interface Issue {
  id: string;
  title: string;
  description: string | null;
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
}

/** `bd ready --json` — issues with no open blockers. */
export async function bdReady(repoPath: string): Promise<Issue[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<Issue[]>('bd_ready', { repoPath });
}

/** `bd show <id> --json --long` — full issue detail. */
export async function bdShow(repoPath: string, id: string): Promise<Issue> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<Issue>('bd_show', { repoPath, id });
}

/**
 * `bd list --json [--status <filter>]`.
 * Pass `null`/`undefined` to list all statuses.
 */
export async function bdList(
  repoPath: string,
  statusFilter?: string | null,
): Promise<Issue[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<Issue[]>('bd_list', {
    repoPath,
    statusFilter: statusFilter ?? null,
  });
}

// ---------------------------------------------------------------------------
// Mutations — Phase 3.
//
// These wrap the Rust `bd_*` commands that mutate issue state. They all
// resolve to void on success and reject with a String error otherwise. Names
// follow camelCase on the JS side; the underlying Tauri commands are
// snake_case (`bd_claim`, `bd_set_status`, …).
//
// Note: the close wrapper is named `bdCloseIssue` to avoid colliding with
// the tab-close metaphor used in the UI layer.
// ---------------------------------------------------------------------------

/** `bd update <id> --claim` — assigns the issue to the current user and flips status to in_progress. */
export async function bdClaim(repoPath: string, id: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<void>('bd_claim', { repoPath, id });
}

/** `bd update <id> --status <status>` — set the issue status to one of open/in_progress/blocked/closed. */
export async function bdSetStatus(
  repoPath: string,
  id: string,
  status: string,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<void>('bd_set_status', { repoPath, id, status });
}

/** `bd close <id> [--reason ...]` — closes an issue with an optional close reason. */
export async function bdCloseIssue(
  repoPath: string,
  id: string,
  reason?: string | null,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<void>('bd_close', { repoPath, id, reason: reason ?? null });
}

/** `bd label add <id> <label>` — attach a label. */
export async function bdAddLabel(
  repoPath: string,
  id: string,
  label: string,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<void>('bd_add_label', { repoPath, id, label });
}

/** `bd label remove <id> <label>` — detach a label. */
export async function bdRemoveLabel(
  repoPath: string,
  id: string,
  label: string,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<void>('bd_remove_label', { repoPath, id, label });
}

/** `bd note add <id> <text>` — append a note/comment to an issue. */
export async function bdNote(
  repoPath: string,
  id: string,
  text: string,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<void>('bd_note', { repoPath, id, text });
}
