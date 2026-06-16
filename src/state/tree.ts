// Pure tree-shaping helpers for the Phase 5 sidebar tree.
//
// NO React imports — these helpers must be unit-testable in any context and
// reusable from Phase 9's command palette (which will fan out over the same
// flat-row list). Stays small and dependency-free on purpose.
//
// Grouping: project label → status bucket → parent/child tree.
// Sort:     priority asc, then id asc (stable).

import type { Issue } from '../types/issue';
import { projectLabelFor } from './projectLabel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TreeNodeKind = 'project' | 'status' | 'issue';

export interface TreeNode {
  kind: TreeNodeKind;
  /**
   * Stable identifier used as React key AND as the expansion-state key in the
   * `expanded: Set<string>` carried by useTreeNav. For project/status group
   * rows this is a synthetic id (e.g. `proj:Beads-Station`,
   * `proj:Beads-Station/status:ready`). For issue rows it is the bd issue id.
   */
  id: string;
  label: string;
  depth: number;
  children: TreeNode[];
  /** Present only on `kind === 'issue'`. */
  issue?: Issue;
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

type StatusBucket = 'ready' | 'in_progress' | 'blocked' | 'closed';

// Display order for status groups within each project.
const STATUS_ORDER: StatusBucket[] = ['in_progress', 'ready', 'blocked', 'closed'];

const STATUS_LABEL: Record<StatusBucket, string> = {
  ready: 'READY',
  in_progress: 'IN PROGRESS',
  blocked: 'BLOCKED',
  closed: 'CLOSED',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBucketOf(issue: Issue): StatusBucket {
  if (issue.status === 'closed') return 'closed';
  if (issue.status === 'in_progress') return 'in_progress';
  if (issue.status === 'blocked') return 'blocked';
  if (issue.status === 'open' && (issue.dependency_count ?? 0) > 0) return 'blocked';
  // status === 'open' && no upstream blockers — true ready bucket.
  return 'ready';
}

/** priority asc, then id asc (stable). */
function sortIssuesStable(issues: Issue[]): Issue[] {
  // Map then sort to guarantee stable ordering even on engines whose Array.sort
  // isn't stable for large arrays. (V8 is, but we leave nothing to chance.)
  return issues
    .map((issue, idx) => ({ issue, idx }))
    .sort((a, b) => {
      const pa = a.issue.priority ?? 99;
      const pb = b.issue.priority ?? 99;
      if (pa !== pb) return pa - pb;
      if (a.issue.id < b.issue.id) return -1;
      if (a.issue.id > b.issue.id) return 1;
      return a.idx - b.idx;
    })
    .map((x) => x.issue);
}

/** Build parent→child trees within a status bucket. Issues whose parent is
 *  not in the same bucket float as roots in this bucket. */
function buildIssueForest(
  issues: Issue[],
  parentDepth: number,
): TreeNode[] {
  const inBucket = new Set(issues.map((i) => i.id));
  const childrenByParent = new Map<string, Issue[]>();
  const rootIssues: Issue[] = [];

  for (const issue of issues) {
    const p = issue.parent;
    if (p && inBucket.has(p)) {
      const arr = childrenByParent.get(p);
      if (arr) arr.push(issue);
      else childrenByParent.set(p, [issue]);
    } else {
      rootIssues.push(issue);
    }
  }

  const sortedRoots = sortIssuesStable(rootIssues);

  function toNode(issue: Issue, depth: number): TreeNode {
    const rawChildren = childrenByParent.get(issue.id) ?? [];
    const sortedChildren = sortIssuesStable(rawChildren);
    return {
      kind: 'issue',
      id: issue.id,
      label: issue.title,
      depth,
      issue,
      children: sortedChildren.map((c) => toNode(c, depth + 1)),
    };
  }

  return sortedRoots.map((r) => toNode(r, parentDepth));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Group an issue list into the project → status → parent/child tree shape. */
export function buildTree(issues: Issue[]): TreeNode[] {
  if (!issues || issues.length === 0) return [];

  // Phase 1: bucket by project label.
  const byProject = new Map<string, Issue[]>();
  for (const issue of issues) {
    const key = projectLabelFor(issue);
    const arr = byProject.get(key);
    if (arr) arr.push(issue);
    else byProject.set(key, [issue]);
  }

  // Stable project order: alpha by label, with '(unlabeled)' last.
  const projectKeys = Array.from(byProject.keys()).sort((a, b) => {
    const aIsUnlabeled = a === '(unlabeled)';
    const bIsUnlabeled = b === '(unlabeled)';
    if (aIsUnlabeled && !bIsUnlabeled) return 1;
    if (!aIsUnlabeled && bIsUnlabeled) return -1;
    return a.localeCompare(b);
  });

  const roots: TreeNode[] = [];
  for (const projectLabel of projectKeys) {
    const projectIssues = byProject.get(projectLabel) ?? [];

    // Phase 2: split into status buckets.
    const byStatus: Record<StatusBucket, Issue[]> = {
      ready: [],
      in_progress: [],
      blocked: [],
      closed: [],
    };
    for (const issue of projectIssues) {
      byStatus[statusBucketOf(issue)].push(issue);
    }

    const projectId = `proj:${projectLabel}`;
    const statusGroups: TreeNode[] = [];

    for (const bucket of STATUS_ORDER) {
      const bucketIssues = byStatus[bucket];
      if (bucketIssues.length === 0) continue;
      const groupId = `${projectId}/status:${bucket}`;
      const issueRoots = buildIssueForest(bucketIssues, /* parentDepth */ 2);
      statusGroups.push({
        kind: 'status',
        id: groupId,
        label: `${STATUS_LABEL[bucket]} (${bucketIssues.length})`,
        depth: 1,
        children: issueRoots,
      });
    }

    roots.push({
      kind: 'project',
      id: projectId,
      label: projectLabel,
      depth: 0,
      children: statusGroups,
    });
  }

  return roots;
}

/** DFS walk producing the visible flat-row list. Skips subtrees whose
 *  parent id is collapsed (i.e. NOT present in `expanded`). */
export function flattenVisible(
  roots: TreeNode[],
  expanded: Set<string>,
): FlatRow[] {
  const out: FlatRow[] = [];

  function walk(node: TreeNode, depth: number) {
    const hasChildren = node.children.length > 0;
    const isExpanded = expanded.has(node.id);
    out.push({ node, depth, hasChildren, expanded: isExpanded });
    if (hasChildren && isExpanded) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  }

  for (const root of roots) {
    walk(root, root.depth);
  }
  return out;
}

/** First issue (leaf) id in the tree, in DFS order. Used as the default
 *  cursor target so an empty tree renders cleanly. */
export function firstIssueId(roots: TreeNode[]): string | null {
  for (const root of roots) {
    const found = firstIssueIn(root);
    if (found) return found;
  }
  return null;
}

function firstIssueIn(node: TreeNode): string | null {
  if (node.kind === 'issue') return node.id;
  for (const child of node.children) {
    const found = firstIssueIn(child);
    if (found) return found;
  }
  return null;
}

/** Path of node ids from root → target (inclusive). Returns [] if not found. */
export function idToPath(roots: TreeNode[], id: string): string[] {
  for (const root of roots) {
    const path = pathFrom(root, id, []);
    if (path) return path;
  }
  return [];
}

function pathFrom(node: TreeNode, target: string, acc: string[]): string[] | null {
  const next = [...acc, node.id];
  if (node.id === target) return next;
  for (const child of node.children) {
    const found = pathFrom(child, target, next);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline smoke tests — DEV-only, never ship to release.
// ---------------------------------------------------------------------------
if (import.meta.env && import.meta.env.DEV) {
  // 1) Empty input.
  const empty = buildTree([]);
  console.assert(Array.isArray(empty) && empty.length === 0, 'tree.ts: empty input should yield []');
  console.assert(firstIssueId(empty) === null, 'tree.ts: firstIssueId([]) === null');
  console.assert(flattenVisible(empty, new Set()).length === 0, 'tree.ts: flattenVisible([],_) === []');

  // 2) Single issue.
  const oneIssue: Issue = {
    id: 'X-1',
    title: '[Demo] only',
    description: null,
    status: 'open',
    priority: 2,
    issue_type: 'task',
    assignee: null,
    created_at: '',
    updated_at: '',
    closed_at: null,
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    labels: ['Demo'],
    parent: null,
  };
  const oneTree = buildTree([oneIssue]);
  console.assert(oneTree.length === 1 && oneTree[0].kind === 'project', 'tree.ts: single issue → 1 project root');
  console.assert(oneTree[0].children[0].kind === 'status', 'tree.ts: project has status child');
  console.assert(oneTree[0].children[0].children[0].id === 'X-1', 'tree.ts: status group has the issue');
  console.assert(firstIssueId(oneTree) === 'X-1', 'tree.ts: firstIssueId picks X-1');

  // 3) Parent with two children — ensure children render as siblings under parent.
  const parentIssue: Issue = { ...oneIssue, id: 'X-100', title: '[Demo] parent', parent: null };
  const childA: Issue = { ...oneIssue, id: 'X-101', title: '[Demo] child A', parent: 'X-100', priority: 1 };
  const childB: Issue = { ...oneIssue, id: 'X-102', title: '[Demo] child B', parent: 'X-100', priority: 1 };
  const fam = buildTree([parentIssue, childA, childB]);
  const projNode = fam[0];
  const statusNode = projNode.children[0];
  const parentNode = statusNode.children.find((n) => n.id === 'X-100');
  console.assert(!!parentNode, 'tree.ts: parent node present');
  console.assert(parentNode!.children.length === 2, 'tree.ts: parent has 2 children');
  console.assert(
    parentNode!.children[0].id === 'X-101' && parentNode!.children[1].id === 'X-102',
    'tree.ts: children sorted by id within same priority',
  );
  // idToPath should hit the leaf.
  const path = idToPath(fam, 'X-102');
  console.assert(path.length === 4 && path[path.length - 1] === 'X-102', 'tree.ts: idToPath reaches leaf');
}
