// RV3-B (Code-8ro) — the file-navigation pane. A virtualized file tree rooted
// at the pane's project path, reusing the shared flattenVisible primitive +
// @tanstack/react-virtual (same 28px fixed rows as the bd sidebar). Vim nav
// (j/k move, l/Enter open/expand, h collapse). Open = read-only preview inline;
// it also dispatches `filenav:open` so RV3-C can wire nav→agent.
//
// NON-GOAL (RV3): editing. This pane reads and jumps only — Claude does edits.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useVirtualizer } from '@tanstack/react-virtual';

import { flattenVisible, type FlatRow } from '../state/tree';
import { resolveTargetAgentBridge, resolveActiveShellPtyId } from '../state/termPanes';
import { buildFileTree, isLoadingPlaceholder, type DirCache } from '../lib/fileTree';
import { listDir, readFile, type FsFilePreview } from '../lib/fsBridge';

interface FileTreeProps {
  rootPath: string;
  /** When true, this pane owns keyboard focus (vim keys route here). */
  active: boolean;
}

export function FileTree({ rootPath, active }: FileTreeProps) {
  const [cache, setCache] = useState<DirCache>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]));
  const [cursor, setCursor] = useState(0);
  const [preview, setPreview] = useState<FsFilePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  // Reset when the pane is re-rooted at a different project.
  useEffect(() => {
    setCache(new Map());
    setExpanded(new Set([rootPath]));
    setCursor(0);
    setPreview(null);
    setErr(null);
    setHint(null);
  }, [rootPath]);

  // Auto-clear the transient hint.
  useEffect(() => {
    if (hint == null) return;
    const id = window.setTimeout(() => setHint(null), 3000);
    return () => window.clearTimeout(id);
  }, [hint]);

  // Lazily list a directory: fetch once, memoize in cache.
  const loadDir = useCallback(
    (path: string) => {
      setCache((prev) => {
        if (prev.has(path)) return prev; // already loaded/loading-resolved
        return prev;
      });
      listDir(path)
        .then((listing) => {
          setCache((prev) => {
            const next = new Map(prev);
            next.set(path, listing.entries);
            return next;
          });
          setErr(null);
        })
        .catch((e) => setErr(String(e)));
    },
    [],
  );

  // Load the root on mount / re-root.
  useEffect(() => {
    loadDir(rootPath);
  }, [rootPath, loadDir]);

  const roots = useMemo(() => buildFileTree(rootPath, cache), [rootPath, cache]);
  const rows: FlatRow[] = useMemo(() => flattenVisible(roots, expanded), [roots, expanded]);

  // Clamp cursor whenever rows shrink.
  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, rows.length - 1)));
  }, [rows.length]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 8,
  });

  useEffect(() => {
    if (rows.length === 0) return;
    rowVirtualizer.scrollToIndex(cursor, { align: 'auto' });
  }, [cursor, rows.length, rowVirtualizer]);

  // When this pane becomes active+focused, pull real DOM focus to the tree
  // root so its scoped keydown handler receives j/k/h/l/Enter.
  useEffect(() => {
    if (active) parentRef.current?.focus();
  }, [active]);

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          loadDir(path); // lazy fetch on first expand
        }
        return next;
      });
    },
    [loadDir],
  );

  const openFile = useCallback((path: string) => {
    readFile(path)
      .then((p) => {
        setPreview(p);
        setErr(null);
        // RV3-C glue seam: announce the opened path so an agent pane can grab it.
        window.dispatchEvent(new CustomEvent('filenav:open', { detail: { path } }));
      })
      .catch((e) => setErr(String(e)));
  }, []);

  // RV3-C — send the cursor's path to an agent pane. Resolves the target
  // (focused agent, else the sole agent) and injects a user message asking
  // Claude to look at the file. A transient hint reports the outcome.
  const sendToAgent = useCallback(
    (path: string) => {
      const bridge = resolveTargetAgentBridge();
      if (!bridge) {
        setHint('no agent pane to send to (spawn one with <leader>a, or focus it)');
        return;
      }
      invoke('claude_send', { projectId: bridge, text: `Please look at this file: ${path}` })
        .then(() => setHint(`sent ${path.split('/').pop()} to agent`))
        .catch((e) => setHint(`send failed: ${String(e)}`));
    },
    [],
  );

  // Code-3yn — open the cursor path in nvim running in the active shell PTY.
  const openInNvim = useCallback(
    (path: string) => {
      const ptyId = resolveActiveShellPtyId();
      if (ptyId == null) {
        setHint('no shell pane focused (switch to a terminal pane first)');
        return;
      }
      // Send "nvim <path>\r" — same as typing the command in the shell.
      invoke('pty_write', { id: ptyId, data: `nvim ${path}\r` })
        .then(() => setHint(`nvim ${path.split('/').pop()}`))
        .catch((e) => setHint(`nvim failed: ${String(e)}`));
    },
    [],
  );

  // Activate the cursor row: dirs toggle, files preview.
  const activateCursor = useCallback(() => {
    const row = rows[cursor];
    if (!row || isLoadingPlaceholder(row.node)) return;
    if (row.node.kind === 'dir') toggleDir(row.node.id);
    else openFile(row.node.id);
  }, [rows, cursor, toggleDir, openFile]);

  // Vim keymap — only while this pane is active. Scoped to the pane element so
  // it doesn't fight the global vim handler (mirrors the agent-input pattern).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const row = rows[cursor];
      switch (e.key) {
        case 'j':
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, rows.length - 1));
          break;
        case 'k':
          e.preventDefault();
          setCursor((c) => Math.max(c - 1, 0));
          break;
        case 'l':
        case 'Enter':
          e.preventDefault();
          activateCursor();
          break;
        case 'h':
          e.preventDefault();
          // Collapse an expanded dir; on a file/collapsed dir, jump to parent.
          if (row && row.node.kind === 'dir' && expanded.has(row.node.id)) {
            toggleDir(row.node.id);
          } else if (row) {
            const parentId = row.ancestorPath[row.ancestorPath.length - 2];
            if (parentId) {
              const pIdx = rows.findIndex((r) => r.node.id === parentId);
              if (pIdx >= 0) setCursor(pIdx);
            }
          }
          break;
        case 'g':
          e.preventDefault();
          setCursor(0);
          break;
        case 'G':
          e.preventDefault();
          setCursor(rows.length - 1);
          break;
        case 's': {
          // RV3-C — send the cursor path to an agent pane.
          e.preventDefault();
          if (row && !isLoadingPlaceholder(row.node)) sendToAgent(row.node.id);
          break;
        }
        case 'y': {
          // RV3-C — yank the cursor path to the clipboard.
          e.preventDefault();
          if (row && !isLoadingPlaceholder(row.node)) {
            const p = row.node.id;
            navigator.clipboard?.writeText(p).then(
              () => setHint(`yanked ${p}`),
              () => setHint('clipboard unavailable'),
            );
          }
          break;
        }
        case 'n': {
          // Code-3yn — open cursor path in nvim in the active shell PTY.
          e.preventDefault();
          if (row && !isLoadingPlaceholder(row.node) && row.node.kind === 'file') {
            openInNvim(row.node.id);
          }
          break;
        }
      }
    };
    const el = parentRef.current;
    el?.addEventListener('keydown', onKey);
    return () => el?.removeEventListener('keydown', onKey);
  }, [active, rows, cursor, expanded, activateCursor, toggleDir, sendToAgent, openInNvim]);

  return (
    <div className="bs-filetree-wrap" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        ref={parentRef}
        role="tree"
        tabIndex={0}
        className="bs-tree bs-filetree"
        aria-label="Files"
        style={{ overflow: 'auto', flex: preview ? '0 0 50%' : 1, outline: 'none' }}
      >
        {err && <div className="bs-filetree-err">{err}</div>}
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            const idx = vi.index;
            const isActive = idx === cursor;
            const loading = isLoadingPlaceholder(row.node);
            const isDir = row.node.kind === 'dir';
            const iconClass = loading
              ? 'codicon codicon-loading'
              : isDir
                ? `codicon codicon-chevron-${row.expanded ? 'down' : 'right'}`
                : 'codicon codicon-file';
            return (
              <div
                key={row.node.id}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={isActive}
                className={`bs-tree-row bs-filetree-row${isActive ? ' bs-tree-row--active' : ''}`}
                onClick={() => {
                  setCursor(idx);
                  if (!loading) {
                    if (isDir) toggleDir(row.node.id);
                    else openFile(row.node.id);
                  }
                }}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: 28,
                  transform: `translateY(${vi.start}px)`,
                  paddingLeft: `${row.depth * 16 + 8}px`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span className={iconClass} style={{ fontSize: 13, opacity: 0.75, flexShrink: 0 }} aria-hidden />
                <span className="bs-filetree-name" style={{ opacity: loading ? 0.5 : 1 }}>
                  {row.node.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {preview && (
        <div className="bs-filepreview" style={{ flex: '1 1 50%', overflow: 'auto', borderTop: '1px solid var(--bs-border)' }}>
          <div className="bs-filepreview-head">
            <span className="codicon codicon-file" aria-hidden /> {preview.path.split('/').pop()}
            {preview.truncated && <span className="bs-filepreview-flag"> · truncated</span>}
            {preview.binary && <span className="bs-filepreview-flag"> · binary</span>}
            <button
              type="button"
              className="bs-filepreview-close"
              onClick={() => setPreview(null)}
              aria-label="close preview"
            >
              <span className="codicon codicon-close" aria-hidden />
            </button>
          </div>
          <pre className="bs-filepreview-body">{preview.content}</pre>
        </div>
      )}
      {/* RV3-C — transient action hint + a discoverability footer for s/y. */}
      <div className="bs-filetree-foot">
        {hint ?? 'l/Enter open · s send to agent · n nvim · y yank path'}
      </div>
    </div>
  );
}
