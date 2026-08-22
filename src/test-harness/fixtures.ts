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
    dependencies: [],
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
 * Code-1bw: scripted frame sequence matching fake-claude.sh output.
 * Call with a bridgeId; the channel names embed it so tests can emit them
 * via __bsMockEmit and verify the FE renders the assistant turns.
 */
export function fakeClaudioFrames(sessionId = 'fake-session-test') {
  const init = { type: 'system', subtype: 'init', session_id: sessionId, tools: [] }
  const assistant1 = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK1' }] } }
  const result1 = { type: 'result', subtype: 'success', session_id: sessionId, cost_usd: 0.0001, usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  const assistant2 = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK2' }] } }
  const result2 = { type: 'result', subtype: 'success', session_id: sessionId, cost_usd: 0.0002, usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  return [init, assistant1, result1, assistant2, result2]
}

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
