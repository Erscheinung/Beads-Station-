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
