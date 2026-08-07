// Beads Station — R12 live-verify harness
// Seed data + frame builders for the browser mockIPC shim. Dev-only:
// this module is dynamically imported from main.tsx solely when
// import.meta.env.VITE_LIVE_MOCK is set, so it never enters a prod bundle.

import type { Project } from '../state/projects'
import type { Issue, BdSnapshotData } from '../types/issue'

const NOW = '2026-08-07T00:00:00Z'

function issue(partial: Partial<Issue> & Pick<Issue, 'id' | 'title' | 'status' | 'priority'>): Issue {
  return {
    description: null,
    issue_type: 'feature',
    assignee: null,
    created_at: NOW,
    updated_at: NOW,
    closed_at: null,
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    labels: null,
    parent: null,
    ...partial,
  }
}

export const PROJECTS: Project[] = [
  { id: 'proj-a', name: 'Beads-Station', path: '/tmp/beads-station', hasGit: true, hasBeads: true, claudeSessionId: '' },
  { id: 'proj-b', name: 'Nexus', path: '/tmp/nexus', hasGit: true, hasBeads: true, claudeSessionId: '' },
]

const READY: Issue[] = [
  issue({ id: 'Code-aaa', title: 'ready alpha', status: 'open', priority: 1 }),
  issue({ id: 'Code-bbb', title: 'ready beta', status: 'open', priority: 2 }),
]

const ALL: Issue[] = [
  ...READY,
  issue({ id: 'Code-ccc', title: 'in flight', status: 'in_progress', priority: 0 }),
  issue({ id: 'Code-ddd', title: 'blocked one', status: 'blocked', priority: 2 }),
  issue({ id: 'Code-eee', title: 'done one', status: 'closed', priority: 3, closed_at: NOW }),
  issue({ id: 'Code-fff', title: 'backlog', status: 'open', priority: 4 }),
]

export const SNAPSHOT: BdSnapshotData = { ready: READY, all: ALL, no_db: false }

/**
 * A `claude_event` frame in the `permission_request` shape that
 * `extractApproval()` (ClaudeChat.tsx:73-107) turns into a pending approval
 * card. Given a requestId + tool name, produces the exact payload the app
 * parses so the a/d approval UI renders.
 */
export function pendingApprovalFrame(requestId: string, toolName = 'Bash') {
  return {
    type: 'permission_request',
    request_id: requestId,
    tool_name: toolName,
    input: { command: 'echo hello' },
  }
}
