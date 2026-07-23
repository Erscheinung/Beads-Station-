// Phase 6 — per-project Claude permission-mode setting (FE persistence layer).
//
// The BE keeps a transient HashMap<project_id, mode> in claude.rs that
// claude_start consults on (re)spawn. This module adds the FE side of the
// contract: the user's choice persists across app restarts via
// tauri-plugin-store, and every change is forwarded to the BE so the next
// session pickup uses the right mode.
//
// We reuse the SAME store filename projects.rs uses ("projects.json") to
// avoid splitting persistence across two files. The keys are namespaced —
// projects.rs writes "<projectId>": "<uuid-v4>" while we write
// "<projectId>.permissionMode": "<mode>". Keys are flat strings so the
// dot is just part of the key, not a nested path.
//
// PermissionModePicker is exported from this same file so the App.tsx
// wiring can mount one render-time portal into the ClaudeChat header
// slot without juggling more imports.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { Store } from '@tauri-apps/plugin-store'

export type PermissionMode = 'acceptEdits' | 'default' | 'plan'

const VALID: ReadonlySet<PermissionMode> = new Set(['acceptEdits', 'default', 'plan'])
const STORE_FILE = 'projects.json'

function storeKey(projectId: string): string {
  return `${projectId}.permissionMode`
}

let _storePromise: Promise<Store> | null = null
function getStore(): Promise<Store> {
  if (_storePromise === null) {
    _storePromise = Store.load(STORE_FILE)
  }
  return _storePromise
}

async function readPersisted(projectId: string): Promise<PermissionMode | null> {
  try {
    const store = await getStore()
    const v = await store.get<string>(storeKey(projectId))
    if (typeof v === 'string' && VALID.has(v as PermissionMode)) {
      return v as PermissionMode
    }
    return null
  } catch (e) {
    console.warn('[claudeSettings] readPersisted failed', e)
    return null
  }
}

async function writePersisted(projectId: string, mode: PermissionMode): Promise<void> {
  try {
    const store = await getStore()
    await store.set(storeKey(projectId), mode)
    await store.save()
  } catch (e) {
    console.warn('[claudeSettings] writePersisted failed', e)
  }
}

interface PermissionModeApi {
  mode: PermissionMode
  setMode: (m: PermissionMode) => void
  hydrated: boolean
}

export function usePermissionMode(projectId: string): PermissionModeApi {
  const [mode, setModeState] = useState<PermissionMode>('acceptEdits')
  const [hydrated, setHydrated] = useState(false)

  // Hydrate on mount + projectId change. While unhydrated we serve the
  // safe default ('acceptEdits') so an early render doesn't downgrade the
  // mode an explicit choice the user already persisted.
  useEffect(() => {
    let cancelled = false
    setHydrated(false)
    readPersisted(projectId).then(p => {
      if (cancelled) return
      if (p) setModeState(p)
      else setModeState('acceptEdits')
      setHydrated(true)
    })
    return () => { cancelled = true }
  }, [projectId])

  // Memoized so the hook does not hand a fresh setMode identity (or a fresh
  // return object) to consumers on every render — defense so no downstream
  // effect keyed on the returned API re-fires in a churn.
  const setMode = useCallback((m: PermissionMode) => {
    if (!VALID.has(m)) return
    setModeState(m)
    void writePersisted(projectId, m)
    invoke('claude_set_permission_mode', { projectId, mode: m }).catch(e =>
      console.warn('[claudeSettings] claude_set_permission_mode rpc failed', e),
    )
  }, [projectId])

  return useMemo(() => ({ mode, setMode, hydrated }), [mode, setMode, hydrated])
}

// ---------- PermissionModePicker ----------
//
// Segmented control with 3 pills. Mounted via createPortal into the
// stable slot #bs-claude-header-right that ClaudeChat renders. If the
// slot isn't in the DOM yet (mount-order race), retry on a tiny tick.

interface PickerProps {
  projectId: string
}

export function PermissionModePicker({ projectId }: PickerProps) {
  const { mode, setMode, hydrated } = usePermissionMode(projectId)
  const [host, setHost] = useState<HTMLElement | null>(null)

  // Retry-find the host element. ClaudeChat is mounted as a sibling under
  // App.tsx; in practice the slot is in the DOM by the time this hook
  // first runs, but the retry guards against StrictMode double-renders
  // and any future App-layout reshuffle.
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let attempts = 0
    const find = () => {
      if (cancelled) return
      const el = document.getElementById('bs-claude-header-right')
      if (el) {
        // Guard on identity: only setState when the host node actually
        // changes. A ClaudeChat re-render that re-emits an equivalent slot
        // node must NOT churn setHost → re-render → setHost. This is the
        // structural root of the R3.5 render-loop (PermissionModePicker
        // churning against ClaudeChat's mount-time re-render burst on a
        // dbless project).
        setHost(prev => (prev === el ? prev : el))
        return // found — stop the retry chain permanently
      }
      // Bounded retry (~10 frames / 160ms) with a cleared timer. An
      // unbounded setTimeout(find,16) chain left orphaned by StrictMode's
      // double-mount is exactly what fed the loop.
      if (attempts++ >= 10) return
      timer = window.setTimeout(find, 16)
    }
    find()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [projectId])

  if (!host) return null
  if (!hydrated) return null

  const segs: PermissionMode[] = ['acceptEdits', 'default', 'plan']
  return createPortal(
    <div className="bs-permmode" role="radiogroup" aria-label="claude permission mode">
      {segs.map(s => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={mode === s}
          className={`bs-permmode-seg${mode === s ? ' bs-permmode-seg--active' : ''}`}
          onClick={() => setMode(s)}
          title={`permission mode: ${s}`}
        >
          {s}
        </button>
      ))}
    </div>,
    host,
  )
}
