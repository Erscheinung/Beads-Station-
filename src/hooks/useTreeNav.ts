// useTreeNav — reactive cursor + expansion state over the pure tree helpers.
//
// Owns: cursorIndex, expanded: Set<string>. Recomputes flatRows from the
// passed-in `issues` whenever they change.
//
// The hook is intentionally thin and emits an `issue:open` window CustomEvent
// on `open()` so useVimNav and useBdLive don't need to know how the tree is
// stored — events are the seam. (See Phase-5 brief.)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildTree,
  flattenVisible,
  idToPath,
  type FlatRow,
  type TreeNode,
} from '../state/tree';
import type { Issue } from '../types/issue';

export interface UseTreeNavResult {
  rows: FlatRow[];
  cursorIndex: number;
  expanded: Set<string>;
  move(delta: number): void;
  toggle(id: string): void;
  expandToward(id: string): void;
  open(): void;
  expandAll(): void;
  collapseAll(): void;
  jumpTo(idx: number): void;
}

/** Walk the tree once and collect ids by kind (used to compute default
 *  expansion sets without re-walking on every render). */
function collectIds(roots: TreeNode[]): {
  projectIds: string[];
  statusIds: string[];
  parentIssueIds: string[];
} {
  const projectIds: string[] = [];
  const statusIds: string[] = [];
  const parentIssueIds: string[] = [];

  function walk(node: TreeNode) {
    if (node.kind === 'project') projectIds.push(node.id);
    else if (node.kind === 'status') statusIds.push(node.id);
    else if (node.kind === 'issue' && node.children.length > 0) parentIssueIds.push(node.id);
    for (const child of node.children) walk(child);
  }
  for (const root of roots) walk(root);
  return { projectIds, statusIds, parentIssueIds };
}

export function useTreeNav(issues: Issue[]): UseTreeNavResult {
  const roots = useMemo(() => buildTree(issues), [issues]);
  const ids = useMemo(() => collectIds(roots), [roots]);

  // Open all groups and parent beads on first discovery.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const id of ids.projectIds) s.add(id);
    for (const id of ids.statusIds) s.add(id);
    for (const id of ids.parentIssueIds) s.add(id);
    return s;
  });

  // When the tree shape changes (new project / new status bucket appears),
  // grow the default-expanded set to include the new groups, but never undo
  // a user collapse on existing ids.
  const knownIdsRef = useRef<Set<string>>(new Set([...ids.projectIds, ...ids.statusIds, ...ids.parentIssueIds]));
  useEffect(() => {
    const known = knownIdsRef.current;
    const added = [...ids.projectIds, ...ids.statusIds, ...ids.parentIssueIds].filter(id => !known.has(id));
    if (added.length === 0) return;
    for (const id of added) known.add(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of added) next.add(id);
      return next;
    });
  }, [ids]);

  const rows = useMemo(() => flattenVisible(roots, expanded), [roots, expanded]);

  const [cursorIndex, setCursorIndex] = useState(0);
  // Clamp the cursor whenever the visible row count shrinks (e.g. user
  // collapsed a parent the cursor was on).
  useEffect(() => {
    if (rows.length === 0) {
      if (cursorIndex !== 0) setCursorIndex(0);
      return;
    }
    if (cursorIndex >= rows.length) setCursorIndex(rows.length - 1);
  }, [rows.length, cursorIndex]);

  const move = useCallback(
    (delta: number) => {
      setCursorIndex((cur) => {
        if (rows.length === 0) return 0;
        const next = cur + delta;
        if (next < 0) return 0;
        if (next > rows.length - 1) return rows.length - 1;
        return next;
      });
    },
    [rows.length],
  );

  const jumpTo = useCallback(
    (idx: number) => {
      setCursorIndex(() => {
        if (rows.length === 0) return 0;
        if (idx < 0) return 0;
        if (idx > rows.length - 1) return rows.length - 1;
        return idx;
      });
    },
    [rows.length],
  );

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandToward = useCallback(
    (id: string) => {
      const path = idToPath(roots, id);
      if (path.length === 0) return;
      setExpanded((prev) => {
        const next = new Set(prev);
        // Expand every ancestor (drop the target itself — leaves stay leaves).
        for (let i = 0; i < path.length - 1; i++) next.add(path[i]);
        return next;
      });
    },
    [roots],
  );

  const open = useCallback(() => {
    if (rows.length === 0) return;
    const row = rows[cursorIndex];
    if (!row) return;
    if (row.node.kind === 'issue' && row.node.issue) {
      window.dispatchEvent(
        new CustomEvent('issue:open', {
          detail: { id: row.node.issue.id, repoPath: '' },
        }),
      );
      return;
    }
    // Group rows: Enter toggles.
    toggle(row.node.id);
  }, [rows, cursorIndex, toggle]);

  const expandAll = useCallback(() => {
    setExpanded(() => {
      const next = new Set<string>();
      for (const id of ids.projectIds) next.add(id);
      for (const id of ids.statusIds) next.add(id);
      for (const id of ids.parentIssueIds) next.add(id);
      return next;
    });
  }, [ids]);

  const collapseAll = useCallback(() => {
    setExpanded(() => {
      const next = new Set<string>();
      // Keep project rows visible — collapse everything beneath them.
      for (const id of ids.projectIds) next.add(id);
      return next;
    });
  }, [ids]);

  return {
    rows,
    cursorIndex,
    expanded,
    move,
    toggle,
    expandToward,
    open,
    expandAll,
    collapseAll,
    jumpTo,
  };
}
