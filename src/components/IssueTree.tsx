// IssueTree — visual primitive for the Phase-5 sidebar tree.
//
// Receives the already-flattened row list + the active cursor index and
// renders one `<div role="treeitem">` per visible row. Indent guides are
// 1px absolute children of the row (per-row segments — NOT a global rule)
// and lit on the cursor's ancestor branch.
//
// All visual styling lives in src/index.css under the `Phase 5 — issue tree`
// block (Worker 2). This file only stamps class names and writes the
// position-dependent `left` for indent guides.

import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { TreeNode, FlatRow } from '../state/tree';
import type { Issue } from '../types/issue';

interface IssueTreeProps {
  roots: TreeNode[];
  flatRows: FlatRow[];
  cursorIndex: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (index: number) => void;
  onOpen: (issue: Issue) => void;
}

// Build the lit-branch set: keys are `${ancestorId}|${depth}`. We include
// every ancestor of the cursor row at every depth so that a row sharing the
// same ancestor at depth d gets its guide-at-d lit. Reads the cursor row's
// precomputed ancestorPath — no idToPath, built once per (flatRows,cursor).
function litBranchKeys(
  flatRows: FlatRow[],
  cursorIndex: number,
): Set<string> {
  const out = new Set<string>();
  if (flatRows.length === 0) return out;
  const idx = Math.max(0, Math.min(cursorIndex, flatRows.length - 1));
  const cursor = flatRows[idx];
  if (!cursor) return out;
  // ancestorPath is [root, ..., cursor.node.id]; emit one key per ancestor at its depth.
  for (let d = 0; d < cursor.ancestorPath.length; d++) {
    out.add(`${cursor.ancestorPath[d]}|${d}`);
  }
  return out;
}

export function IssueTree({
  roots: _roots,
  flatRows,
  cursorIndex,
  expanded: _expanded,
  onToggle,
  onSelect,
  onOpen,
}: IssueTreeProps) {
  // `_expanded` is part of the public surface so callers can pass the
  // canonical Set without conditionals; the per-row expansion state we
  // actually render from is already projected into FlatRow.expanded.
  // `_roots` stays in the props surface but is no longer read per-render —
  // FlatRow.ancestorPath carries what the guides need.
  const lit = useMemo(
    () => litBranchKeys(flatRows, cursorIndex),
    [flatRows, cursorIndex],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 8,
  });

  // Keep the cursor row in view as vim j/k moves it — with virtualization the
  // active row can otherwise scroll out of the rendered window. 'auto' only
  // scrolls when the row is actually outside the viewport (no jitter on
  // already-visible rows). Fixed 28px rows mean the estimate is exact.
  useEffect(() => {
    if (flatRows.length === 0) return;
    rowVirtualizer.scrollToIndex(cursorIndex, { align: 'auto' });
  }, [cursorIndex, flatRows.length, rowVirtualizer]);

  return (
    <div
      ref={parentRef}
      role="tree"
      className="bs-tree"
      aria-label="Issues"
      style={{ overflow: 'auto', height: '100%' }}
    >
      {flatRows.length === 0 ? (
        // Code-o40.6 — an empty tree body was a silent blank scroll area. Give
        // it a centered placeholder so the surface reads as "loaded, nothing to
        // show" rather than broken. (The IssueList header still carries the
        // authoritative '(0)' / 'no beads db' count.)
        <div
          style={{
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--bs-fg-faint)',
            fontSize: 12,
            userSelect: 'none',
          }}
        >
          No issues.
        </div>
      ) : (
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((vi) => {
          const row = flatRows[vi.index];
          const idx = vi.index;
          const isActive = idx === cursorIndex;
          const isGroup = row.node.kind !== 'issue';
          // ancestorPath includes the row itself at the end; the indent-guide
          // columns we draw run d=0..depth-1, addressing ancestors at those depths.
          const ancestorPath = row.ancestorPath;

          const rowClasses = [
            'bs-tree-row',
            isGroup ? 'bs-tree-row--group' : '',
            isActive ? 'bs-tree-row--active' : '',
          ]
            .filter(Boolean)
            .join(' ');

          const paddingLeft = `${row.depth * 16 + 8}px`;

          return (
            <div
              key={row.node.id}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              aria-selected={isActive}
              className={rowClasses}
              style={{
                paddingLeft,
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: 28,
                transform: `translateY(${vi.start}px)`,
              }}
              onClick={() => {
                onSelect(idx);
                if (!isGroup && row.node.issue) {
                  // Single-click selects; double-click handled below.
                }
              }}
              onDoubleClick={() => {
                if (!isGroup && row.node.issue) onOpen(row.node.issue);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (isGroup) onToggle(row.node.id);
                  else if (row.node.issue) onOpen(row.node.issue);
                }
              }}
            >
              {/* Indent guides: one 1px column per ancestor depth. */}
              {Array.from({ length: row.depth }, (_, d) => {
                const ancestorAtD = ancestorPath[d];
                const isLit = ancestorAtD ? lit.has(`${ancestorPath[d]}|${d}`) : false;
                return (
                  <div
                    key={`guide-${d}`}
                    className={`bs-tree-guide${isLit ? ' bs-tree-guide--lit' : ''}`}
                    style={{ left: `${(d + 0.5) * 16}px` }}
                    aria-hidden="true"
                  />
                );
              })}

              {/* Chevron — always present for layout symmetry; hidden via CSS on leaves. */}
              <span
                className={
                  'bs-tree-chevron' +
                  (row.hasChildren
                    ? row.expanded
                      ? ' bs-tree-chevron--expanded'
                      : ''
                    : ' bs-tree-chevron--leaf')
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (row.hasChildren) onToggle(row.node.id);
                }}
              >
                <span className="codicon codicon-chevron-right" aria-hidden="true" />
              </span>

              {row.node.kind === 'issue' && row.node.issue ? (
                <IssueRowContent issue={row.node.issue} />
              ) : (
                <span className="bs-tree-grouplabel">{row.node.label}</span>
              )}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

// Inner row content for issue rows. Worker 2 owns the actual codicon glyphs
// and the status-dot color rules; here we only stamp the carrier class names.
function IssueRowContent({ issue }: { issue: Issue }) {
  const typeKey = issue.issue_type || 'unknown';
  // Downstream-ring indicator: open issues that block other open work get a
  // 2px yellow ring around their status dot so reviewers can see at a glance
  // that something is parked behind them.
  const showDownstreamRing =
    issue.status === 'open' && (issue.dependent_count ?? 0) > 0;
  const dotStyle = showDownstreamRing
    ? { boxShadow: '0 0 0 2px var(--bs-yellow)' }
    : undefined;
  return (
    <>
      <span
        className={`bs-issuetype bs-issuetype--${typeKey}`}
        aria-label={`type: ${typeKey}`}
      />
      <span className="bs-tree-id">{issue.id}</span>
      <span className="bs-tree-title">{issue.title}</span>
      <span
        className={`bs-status-dot bs-status--${issue.status}`}
        style={dotStyle}
        aria-label={`status: ${issue.status}`}
      />
    </>
  );
}
