// IssueList — Phase-5 sidebar wrapper.
//
// Composes the pure tree state (buildTree) + reactive nav (useTreeNav) +
// live bd refresh (useBdLive) and renders the shared IssueTree primitive.
//
// Subscribes to two window events so useVimNav (and any future command
// surface) can drive the cursor without holding a ref to this component:
//   - "sidebar:cursor"  detail: { delta: number }
//   - "sidebar:cmd"     detail: { cmd: "expand"|"collapse"|"open"
//                                     |"expandAll"|"collapseAll"
//                                     |"first"|"last" }
// On open we re-emit "issue:open" with both id AND repoPath so the detail
// pane (Worker 4) can bind to the right repo.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { IssueTree } from './IssueTree';
import { useBdLiveContext } from '../lib/BdLiveProvider';
import { useTreeNav } from '../hooks/useTreeNav';
import { buildTree } from '../state/tree';
import { projectLabelFor } from '../state/projectLabel';
import { bdList, type Issue } from '../types/issue';

interface SidebarCursorDetail {
  delta?: number;
}
type SidebarCmd =
  | 'expand'
  | 'collapse'
  | 'open'
  | 'expandAll'
  | 'collapseAll'
  | 'first'
  | 'last';
interface SidebarCmdDetail {
  cmd?: SidebarCmd;
}

export function IssueList({ repoPath }: { repoPath: string }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // False until the first fetch for THIS repoPath resolves. Distinguishes the
  // load window (empty because bd hasn't answered yet — bd_list can take
  // several seconds cold) from a genuinely empty/absent db. Without this an
  // in-flight fetch renders as "no beads db · 0" (RV3.2 / Code-hc9).
  const [loaded, setLoaded] = useState(false);

  // Reset the loaded gate whenever the repo changes so the new repo's load
  // window doesn't inherit the previous repo's "loaded" truth.
  useEffect(() => {
    setLoaded(false);
  }, [repoPath]);

  const refetch = useCallback(() => {
    bdList(repoPath, null)
      .then((rows) => {
        setIssues(rows);
        setErr(null);
        setLoaded(true);
      })
      .catch((e) => {
        setErr(String(e));
        setLoaded(true);
      });
  }, [repoPath]);

  // Initial fetch + on every (debounced) bd_changed:{repoPath}.
  useEffect(() => {
    refetch();
  }, [refetch]);
  useBdLiveContext(repoPath, refetch);

  // Self-heal a transient empty (see Board.tsx / RV3.2 Code-hc9): while loaded
  // but empty with no error, re-poll every 4s until issues appear or a real
  // error surfaces. Stops once the repo is confirmed non-empty.
  useEffect(() => {
    if (!loaded) return;
    if (issues.length > 0 || err) return;
    const id = window.setInterval(refetch, 4000);
    return () => window.clearInterval(id);
  }, [loaded, issues.length, err, refetch]);

  const roots = useMemo(() => buildTree(issues), [issues]);
  const nav = useTreeNav(issues);

  // Header label: if every issue lives in a single project bucket, surface
  // that label; otherwise render "ALL".
  const headerLabel = useMemo(() => {
    if (issues.length === 0) return 'ALL';
    const labels = new Set<string>();
    for (const i of issues) {
      labels.add(projectLabelFor(i));
      if (labels.size > 1) return 'ALL';
    }
    const only = labels.values().next().value;
    return only ?? 'ALL';
  }, [issues]);

  // Window-event seam — useVimNav fires these without holding a ref.
  useEffect(() => {
    const onCursor = (e: Event) => {
      const detail = (e as CustomEvent<SidebarCursorDetail>).detail ?? {};
      const delta = typeof detail.delta === 'number' ? detail.delta : 0;
      if (delta !== 0) nav.move(delta);
    };
    const onCmd = (e: Event) => {
      const detail = (e as CustomEvent<SidebarCmdDetail>).detail ?? {};
      const cmd = detail.cmd;
      if (!cmd) return;
      switch (cmd) {
        case 'expand': {
          const row = nav.rows[nav.cursorIndex];
          if (row) nav.expandToward(row.node.id);
          break;
        }
        case 'collapse': {
          const row = nav.rows[nav.cursorIndex];
          if (row) nav.toggle(row.node.id);
          break;
        }
        case 'open':
          nav.open();
          break;
        case 'expandAll':
          nav.expandAll();
          break;
        case 'collapseAll':
          nav.collapseAll();
          break;
        case 'first':
          nav.jumpTo(0);
          break;
        case 'last':
          nav.jumpTo(nav.rows.length - 1);
          break;
      }
    };
    window.addEventListener('sidebar:cursor', onCursor as EventListener);
    window.addEventListener('sidebar:cmd', onCmd as EventListener);
    return () => {
      window.removeEventListener('sidebar:cursor', onCursor as EventListener);
      window.removeEventListener('sidebar:cmd', onCmd as EventListener);
    };
  }, [nav]);

  if (err) {
    return (
      <pre style={{ color: 'var(--bs-red)', padding: 12 }}>{err}</pre>
    );
  }

  return (
    <div className="bs-issuelist" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="bs-issuelist-header">
        BEADS · {!loaded ? 'loading…' : issues.length === 0 ? 'no beads db · 0' : `${headerLabel} (${issues.length})`}
      </div>
      <div className="bs-issuelist-scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <IssueTree
          roots={roots}
          flatRows={nav.rows}
          cursorIndex={nav.cursorIndex}
          expanded={nav.expanded}
          onToggle={nav.toggle}
          onSelect={(idx) => nav.jumpTo(idx)}
          onOpen={(issue) =>
            window.dispatchEvent(
              new CustomEvent('issue:open', {
                detail: { id: issue.id, repoPath },
              }),
            )
          }
        />
      </div>
    </div>
  );
}
