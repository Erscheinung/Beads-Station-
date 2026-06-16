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

import type { TreeNode, FlatRow } from '../state/tree';
import { idToPath } from '../state/tree';
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
// same ancestor at depth d gets its guide-at-d lit.
function litBranchKeys(
  roots: TreeNode[],
  flatRows: FlatRow[],
  cursorIndex: number,
): Set<string> {
  const out = new Set<string>();
  if (flatRows.length === 0) return out;
  const safeIdx = Math.max(0, Math.min(cursorIndex, flatRows.length - 1));
  const cursor = flatRows[safeIdx];
  if (!cursor) return out;
  const path = idToPath(roots, cursor.node.id);
  // path is [root, ..., cursor.node.id]; emit one key per ancestor at its depth.
  for (let d = 0; d < path.length; d++) {
    out.add(`${path[d]}|${d}`);
  }
  return out;
}

export function IssueTree({
  roots,
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
  const lit = litBranchKeys(roots, flatRows, cursorIndex);

  // For each visible row we need to know which ancestor id occupies depth d
  // (for d in 0..depth-1) — that controls whether the guide at column d is lit.
  // We compute that lazily by walking idToPath per row; for typical sidebar
  // sizes (≤ a few hundred rows) this is fine and avoids threading auxiliary
  // bookkeeping through the flatten step.

  return (
    <div role="tree" className="bs-tree" aria-label="Issues">
      {flatRows.map((row, idx) => {
        const isActive = idx === cursorIndex;
        const isGroup = row.node.kind !== 'issue';
        const ancestorPath = idToPath(roots, row.node.id);
        // ancestorPath includes the row itself at the end; the indent-guide
        // columns we draw run d=0..depth-1, addressing ancestors at those depths.

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
            style={{ paddingLeft }}
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
              const isLit = ancestorAtD ? lit.has(`${ancestorAtD}|${d}`) : false;
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
  );
}

// Inner row content for issue rows. Worker 2 owns the actual codicon glyphs
// and the status-dot color rules; here we only stamp the carrier class names.
function IssueRowContent({ issue }: { issue: Issue }) {
  const typeKey = issue.issue_type || 'unknown';
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
        aria-label={`status: ${issue.status}`}
      />
    </>
  );
}
