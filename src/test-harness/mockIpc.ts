// Beads Station — R12 live-verify harness
// Browser-mode Tauri IPC shim. Lets the React app boot in plain Chrome
// (vite dev @ localhost:1420, no Tauri runtime) so Playwright can drive real
// focus/keydown/render — the frontend behavior headless vitest cannot reach.
//
// mockIPC() patches window.__TAURI_INTERNALS__.invoke, which BOTH the scattered
// direct `invoke` calls AND safeInvoke's dynamic import('@tauri-apps/api/core')
// read through — one install covers the whole IPC surface. shouldMockEvents:true
// routes plugin:event|listen/emit through the mock's own listener map, so
// emit(channel, payload) delivers to the app's listen() handlers.
//
// Dev-only: dynamically imported from main.tsx behind VITE_LIVE_MOCK. Never
// bundled into a production build.

import { mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { PROJECTS, SNAPSHOT } from './fixtures'

declare global {
  interface Window {
    /** Test hook: fire a Tauri event into the app (e.g. a claude_event frame). */
    __bsMockEmit?: (channel: string, payload: unknown) => Promise<void>
    /** Set once the mock IPC layer is installed — Playwright waits on this. */
    __bsMockReady?: boolean
    /** Ordered log of every invoke the app made — tests assert against it
     *  (e.g. that pressing 'a' fired claude_approve with the right requestId). */
    __bsInvokeLog?: Array<{ cmd: string; args: Record<string, unknown> | undefined }>
    /** Per-cmd response override, seeded by a spec BEFORE boot (via
     *  page.addInitScript) to exercise empty/error conditions the static
     *  fixtures can't. A value replaces the routed return; the sentinel
     *  string '__bsThrow' (optionally '__bsThrow:<message>') makes that cmd
     *  reject, so a test can drive the ERROR path of any surface. */
    __bsMockOverride?: Record<string, unknown>
  }
}

const THROW_SENTINEL = '__bsThrow'

/** Router for every `invoke(cmd, args)` the app makes. Unknown commands
 *  resolve to null (void) so a new call site never crashes the harness;
 *  add a case here when a test needs a specific return shape. */
function route(cmd: string, args: Record<string, unknown> | undefined): unknown {
  switch (cmd) {
    // --- reads the app makes on mount (must all succeed, else InvokeErrorBoundary toasts) ---
    case 'projects_list':
      return { projects: PROJECTS, roots: ['/tmp'], warnings: [] }
    case 'projects_set_roots':
      return { projects: PROJECTS, roots: args?.roots ?? [], warnings: [] }
    case 'projects_open': {
      const path = args?.path as string
      return PROJECTS.find(p => p.path === path) ?? { id: path, name: path.split('/').pop(), path, hasGit: false, hasBeads: false, claudeSessionId: 'opened-session' }
    }
    case 'projects_get':
      return PROJECTS.find(p => p.id === (args?.id as string)) ?? PROJECTS[0]
    case 'bd_snapshot':
      return SNAPSHOT
    case 'bd_ready':
      return SNAPSHOT.ready
    case 'bd_list':
      return SNAPSHOT.all
    case 'bd_show':
      return SNAPSHOT.all.find(i => i.id === (args?.id as string)) ?? SNAPSHOT.all[0]
    case 'bd_git_branch':
      return 'main'
    case 'bd_prime':
      return ''

    // Code-9d8 — Gateway spend aggregate. A live value so the CostMeter's
    // right-aligned `day/mo` row renders in the harness. The real command reads
    // a cached Bearer token and hits gateway.example.com.
    case 'gateway_spending':
      return {
        available: true,
        dailyEur: 4.79,
        monthlyEur: 114.91,
        dailyLimitEur: 50,
        monthlyLimitEur: 500,
        plan: 'Pro',
      }

    // --- PTY: hand back a fake id so Terminal panes mount without a real pty ---
    case 'pty_spawn':
      return 1

    // --- RV3-B file-nav (Code-8ro): a small deterministic tree + file preview
    //     so a filenav pane renders real rows instead of an empty pane. ---
    case 'list_dir': {
      const path = (args?.path as string) ?? '/tmp/beads-station'
      return {
        entries: [
          { path: `${path}/src`, name: 'src', isDir: true },
          { path: `${path}/README.md`, name: 'README.md', isDir: false },
          { path: `${path}/package.json`, name: 'package.json', isDir: false },
        ],
        truncated: false,
      }
    }
    case 'read_file': {
      const path = (args?.path as string) ?? '/tmp/beads-station/README.md'
      return {
        path,
        content: `# ${path.split('/').pop()}\n\nMock preview body for live-verify.\n`,
        truncated: false,
        binary: false,
        totalBytes: 64,
      }
    }

    // --- RV5.0 (Code-ew0): cockpit gate view. bd_gate_list returns one open
    //     human gate so a test can assert the card + approve/reject render;
    //     bd_gate_resolve is fire-and-forget void. ---
    case 'bd_gate_list':
      return [
        {
          id: 'Code-mol-gate1',
          title: 'Gate: human',
          description: 'Async gate for step human-gate',
          status: 'open',
          await_type: 'human',
          is_template: false,
          created_at: '2026-08-12T16:00:00Z',
        },
      ]

    // --- RV5.1 (Code-qqa): sensors panel. sense_scan reports how many wisps it
    //     minted; sense_list returns one open wisp so a test can assert the card
    //     + promote/dismiss render. sense_promote/dismiss/watch_* are void. ---
    case 'sense_scan':
      return 0
    case 'sense_list':
      return [
        {
          id: 'Code-wisp-abc',
          title: 'rv51-smoke',
          description: 'Sensed from Implementation Prompts/rv51-smoke.md',
          status: 'open',
          created_at: '2026-08-12T16:30:00Z',
          source: 'Implementation Prompts/rv51-smoke.md',
        },
      ]

    // --- Phase 7 (Code-ky4.7): daily writer returns a DailyWrite shape so a
    //     "Save Update" call in a test gets a real path/date/created back. ---
    case 'daily_append': {
      const title = (args?.title as string) ?? ''
      return { path: `/tmp/beads-daily/2026-08-12.md`, date: '2026-08-12', created: title === 'first' }
    }

    // --- Phase 9 (Code-ky4.9): command palette. bd_create returns the new
    //     issue id (string); bd_claim + daily_append already covered (claim
    //     falls through to void, daily_append has a case above). ---
    case 'bd_create':
      return 'Code-new1'

    // --- Code-9ud: Intelligent Conductor. conductor_start/stop are
    //     fire-and-forget void; live status is pushed via __bsMockEmit
    //     ('conductor_status', …) in the spec, flowing to the app's listen()
    //     handlers (shouldMockEvents:true). ---
    case 'conductor_start':
    case 'conductor_stop':
      return null

    // --- Code-1bw: claude bridge commands. claude_start/send/kill/kill_all/
    //     reconcile/set_permission_mode are fire-and-forget void (the test
    //     controls frame delivery via __bsMockEmit). claude_get_scrollback
    //     and claude_get_session_id return empty/null so the app doesn't crash
    //     on mount; tests push frames directly via __bsMockEmit. ---
    case 'claude_start':
    case 'claude_send':
    case 'claude_kill':
    case 'claude_kill_all':
    case 'claude_reconcile':
    case 'claude_set_permission_mode':
    case 'claude_approve':
    case 'claude_deny':
      return null
    case 'claude_get_scrollback':
      return []
    case 'claude_get_session_id':
      return null
    case 'native_run_snapshot':
      return []

    // --- everything else is fire-and-forget void (watcher_start,
    //     bd mutations, pty_write/resize/kill, set_status, etc.) ---
    default:
      return null
  }
}

export function installMockIpc(): void {
  window.__bsInvokeLog = []
  mockIPC((cmd, args) => {
    window.__bsInvokeLog!.push({ cmd, args: args as Record<string, unknown> | undefined })
    // A spec-seeded override wins over the static fixture, and can force a
    // rejection via the throw sentinel to drive a surface's ERROR branch.
    const override = window.__bsMockOverride
    if (override && Object.prototype.hasOwnProperty.call(override, cmd)) {
      const val = override[cmd]
      if (typeof val === 'string' && val.startsWith(THROW_SENTINEL)) {
        const msg = val.slice(THROW_SENTINEL.length).replace(/^:/, '') || `mock ${cmd} rejected`
        throw new Error(msg)
      }
      return cmd === 'projects_list' && Array.isArray(val) ? { projects: val, roots: [], warnings: [] } : val
    }
    return route(cmd, args as Record<string, unknown> | undefined)
  }, {
    shouldMockEvents: true,
  })

  // emit() now flows through the mock's listener map to the app's listen()
  // handlers. Expose it so Playwright can push frames (approval requests,
  // status changes) at the exact moment a test needs them.
  window.__bsMockEmit = (channel: string, payload: unknown) => emit(channel, payload)
  window.__bsMockReady = true
}
