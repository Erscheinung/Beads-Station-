// R1 (Pillar 2: async-cleanup discipline) — BdLive fan-out provider.
//
// Supersedes the per-caller useBdLive hook. Previously Board and IssueList
// each armed their OWN listen('bd_changed:{repoPath}') for the same repo —
// two OS listeners for one channel. This provider keeps exactly ONE
// safeListen per repoPath and fans out to all subscribers, ref-counting
// them so the listener tears down (via AbortController) when the last
// subscriber unmounts.
//
// The 100ms react-side debounce that useBdLive applied per-caller is now
// applied ONCE at the provider (single timer per repoPath) before fanning
// out — preserving the original coalescing behavior.

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { safeListen } from './safeListen';

const REACT_DEBOUNCE_MS = 100;

interface BdLiveEntry {
  // Teardown is via ac.abort() (safeListen owns the unlisten handle); we
  // never store a raw unlisten here.
  ac: AbortController;
  refCount: number;
  callbacks: Set<() => void>;
  pending: ReturnType<typeof setTimeout> | null;
}

type BdLiveMap = Map<string, BdLiveEntry>;

const BdLiveContext = createContext<BdLiveMap | null>(null);

/**
 * Provides the shared bd_changed fan-out map. Wrap the subtree that hosts
 * every component subscribing via useBdLiveContext (Board + IssueList).
 */
export function BdLiveProvider({ children }: { children: ReactNode }) {
  // The map is mutable and must survive re-renders without being state.
  const mapRef = useRef<BdLiveMap>(new Map());
  return (
    <BdLiveContext.Provider value={mapRef.current}>
      {children}
    </BdLiveContext.Provider>
  );
}

/**
 * Subscribe to backend file-watch events for `repoPath/.beads/`, sharing a
 * single listener across all subscribers of the same repoPath. `onChange`
 * is invoked (debounced 100ms at the provider) on each change.
 */
export function useBdLiveContext(repoPath: string, onChange: () => void): void {
  const map = useContext(BdLiveContext);
  if (!map) {
    throw new Error('useBdLiveContext must be used within a <BdLiveProvider>');
  }

  // Hold onChange in a ref so a new closure identity doesn't re-arm.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!repoPath) return;

    // Ref-wrapped callback: stable identity for add/remove from the set.
    const cb = () => onChangeRef.current();

    let entry = map.get(repoPath);
    const isFirst = !entry;
    if (!entry) {
      entry = {
        ac: new AbortController(),
        refCount: 0,
        callbacks: new Set(),
        pending: null,
      };
      map.set(repoPath, entry);
    }
    entry.refCount += 1;
    entry.callbacks.add(cb);

    if (isFirst) {
      const created = entry;
      const trigger = () => {
        if (created.pending !== null) clearTimeout(created.pending);
        created.pending = setTimeout(() => {
          created.pending = null;
          created.callbacks.forEach(fn => fn());
        }, REACT_DEBOUNCE_MS);
      };
      void (async () => {
        try {
          await invoke('watcher_start', { repoPath });
        } catch (err) {
          console.warn('[BdLiveProvider] watcher_start failed:', err);
          return;
        }
        try {
          await safeListen(`bd_changed:${repoPath}`, () => {
            trigger();
          }, created.ac.signal);
        } catch (err) {
          console.warn('[BdLiveProvider] listen failed:', err);
        }
      })();
    }

    return () => {
      const ent = map.get(repoPath);
      if (!ent) return;
      ent.callbacks.delete(cb);
      ent.refCount -= 1;
      if (ent.refCount <= 0) {
        // ac.abort() tears down the safeListen; clear any pending debounce.
        ent.ac.abort();
        if (ent.pending !== null) {
          clearTimeout(ent.pending);
          ent.pending = null;
        }
        map.delete(repoPath);
        // Note: no watcher_stop — single global watcher, dropped on app exit.
      }
    };
  }, [repoPath, map]);
}
