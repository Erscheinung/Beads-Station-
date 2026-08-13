// Phase 4 — Global vim-style keymap.
//
// Installs a single window-level keydown listener on mount. The
// handler bypasses any event whose target is an editable element
// (input, textarea, contentEditable, xterm, ProseMirror) — when the
// user is typing into a real text surface, vim navigation has no
// business intercepting their keystrokes.
//
// Bindings (no leader):
//   j / k             — cursor down/up in the focused pane
//   h / l             — cursor left/right when board is focused;
//                       collapse / expand row when sidebar is focused
//   Tab / Shift+Tab   — column nav when board is focused
//   Enter / o         — open issue (focused !== chat); when sidebar is
//                       focused, dispatches sidebar:cmd { open }
//   /                 — focus the terminal
//   gq (within 700ms) — quit, with confirm
//   gg (within 250ms) — first row in sidebar
//   G                 — last row in sidebar
//   zR (within 250ms) — expand all rows in sidebar
//   zM (within 250ms) — collapse all rows in sidebar
//
// Leader (Space, then within 1s):
//   p — project:cycle
//   b — focus board
//   c — focus chat
//   s — focus sidebar
//   q — quit, with confirm
//
// Leader can also be armed with Cmd-P (mac) / Ctrl-P from ANY focus —
// including a focused chat/agent input or xterm, where a bare Space would
// (correctly) type a space instead. This is the discoverable escape hatch
// out of an editable surface (RV3.4).
//
// All non-passthrough handled keys preventDefault to avoid the page
// scrolling on Space, Tab focus-traversal, etc.

import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { setFocused, setLeaderActive } from '../state/vim'
import { openPalette } from '../state/palette'
import {
  splitActive,
  closeActivePane,
  newTab,
  switchTab,
  cycleTab,
  moveFocus,
  cyclePane,
  toggleZoom,
  setInsert,
} from '../state/termPanes'
import { killPty } from '../components/TerminalPanes'

const GQ_COMBO_TIMEOUT_MS = 700
const COMBO_TIMEOUT_MS = 250

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false
  const el = target as HTMLElement
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.getAttribute && el.getAttribute('role') === 'textbox') return true
  if ((el as HTMLElement).isContentEditable) return true
  if (el.closest && (el.closest('.xterm') || el.closest('.ProseMirror'))) return true
  return false
}

async function tryQuit(): Promise<void> {
  // window.confirm is synchronous and good enough for Phase 4. If the
  // user declines, do nothing.
  if (!window.confirm('Quit Beads Station?')) return
  try {
    // Lazy import — keeps this file safe to import in a non-Tauri
    // context (tests, storybook). If the API is missing we just
    // no-op; the worst case is the user has to use Cmd-Q.
    const mod = await import('@tauri-apps/api/window')
    const w = mod.getCurrentWindow()
    await w.close()
  } catch {
    /* fallback: noop */
  }
}

function scrollChat(delta: number): void {
  const el = document.querySelector('.bs-chat-scroll') as HTMLElement | null
  if (el) {
    el.scrollBy({ top: delta, behavior: 'auto' })
  } else {
    window.scrollBy({ top: delta, behavior: 'auto' })
  }
}

function focusXterm(): void {
  const ta = document.querySelector('.xterm textarea') as HTMLTextAreaElement | null
  if (ta) ta.focus()
}

// RV2 — focus the active agent pane's input on entering insert mode. Unlike
// xterm (which the shell path relies on being auto-focused), the agent <input>
// must be focused explicitly or the first keystroke after `i`/Enter is dropped
// (G2). Scope to the active pane's wrapper via bridgeId; fall back to the first
// agent input if the active bridge isn't resolvable from here.
function focusAgentInput(bridgeId: string | null): void {
  const sel = bridgeId
    ? `[data-bs-agent-pane="${CSS.escape(bridgeId)}"] [data-bs-agent-input]`
    : '[data-bs-agent-pane] [data-bs-agent-input]'
  const el = document.querySelector(sel) as HTMLInputElement | null
  el?.focus()
}

function dispatchSidebarCmd(cmd: string): void {
  window.dispatchEvent(new CustomEvent('sidebar:cmd', { detail: { cmd } }))
}

export function useVimNav(): void {
  useEffect(() => {
    let leaderTimer: number | null = null
    // Pending leading key for multi-char combos (g, z). The 'g' family
    // splits between gq (quit, 700ms window) and gg (first row, 250ms);
    // we track the timestamp and the leading char and route on the
    // second key. 'z' is the leader for zR / zM (expand/collapse all).
    let pendingKey: 'g' | 'z' | null = null
    let pendingAt = 0
    // RV1 — C-w window-command prefix (terminal pane focus moves/close).
    let pendingCw = false
    let pendingCwAt = 0
    const CW_TIMEOUT_MS = 900
    // RV2 fix — set per-event: true when a leader chord is mid-resolution so
    // the editable-target bypass lets the second key through even while an
    // agent/chat input holds focus.
    let leaderChordActive = false

    const onKeyDown = (event: KeyboardEvent) => {
      // ----- Phase 9: command palette -----
      // Cmd/Ctrl+K opens the palette from ANY focus (blur editable first so the
      // command lands cleanly, same idiom as the Cmd-P leader hatch below). We
      // deliberately keep the palette OFF Cmd-P: that chord already arms the vim
      // leader (a tested, documented binding) — Cmd+K is the cmdk convention.
      if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')
          && !event.altKey && !event.shiftKey) {
        const el = document.activeElement as HTMLElement | null
        el?.blur?.()
        openPalette()
        event.preventDefault()
        return
      }
      // While the palette is open, cmdk owns the keyboard (arrows/Enter/Esc +
      // its own input). Stand down so no nav key leaks to the shell behind the
      // modal. cmdk closes via onOpenChange, which flips this back.
      if ((window as unknown as { __bsPalette?: { open: boolean } }).__bsPalette?.open) {
        return
      }

      // ----- RV1: terminal pane management (runs BEFORE the editable-target
      // bypass, so Esc can leave insert mode even while xterm has focus). -----
      const termMirror = (window as unknown as {
        __bsTerm?: {
          insert: boolean
          paneCount: number
          activeIsAgent: boolean
          activeAgentBridgeId: string | null
          activeIsFileNav: boolean
        }
      }).__bsTerm
      const vimMirror = (window as unknown as { __bsVim?: { focused: string } }).__bsVim
      const termFocused = (vimMirror?.focused ?? 'board') === 'terminal'

      // ----- RV3.4: global leader escape-hatch (Cmd/Ctrl-P) -----
      // A bare Space cannot arm leader while an editable (Claude/agent input,
      // xterm, legacy chat) holds focus — the keystroke belongs to that surface
      // and swallowing Space would break typing spaces. Esc-to-normal-first is
      // the intended flow but undiscoverable, so provide an explicit modifier
      // chord that never collides with text input and arms leader from ANY
      // focus. Cmd-P (mac) / Ctrl-P — same persistent semantics as bare Space.
      // Runs before the terminal block AND the editable bypass so it works in
      // xterm/agent-input insert mode and non-terminal inputs uniformly. The
      // next key then resolves via whichever leader path owns the current focus
      // (terminal pane-op switch, or the global switch via leaderChordActive).
      if ((event.metaKey || event.ctrlKey) && (event.key === 'p' || event.key === 'P')
          && !event.altKey && !event.shiftKey) {
        // Blur any focused editable + drop insert so the resolved command lands
        // cleanly (mirrors the bare-Space-in-editable handling below).
        if (isEditableTarget(event.target)) {
          const el = document.activeElement as HTMLElement | null
          el?.blur?.()
        }
        if (termMirror?.insert) setInsert(false)
        setLeaderActive(true)
        leaderChordActive = true
        event.preventDefault()
        return
      }

      // Shift-Tab / Ctrl-Shift-Tab — cycle project tabs from ANY focus (insert,
      // board, terminal). Shift-Tab goes forward, Ctrl-Shift-Tab backward. Runs
      // before the board's plain-Tab column-nav so plain Tab is unaffected.
      // preventDefault stops the browser's own focus traversal.
      if (event.key === 'Tab' && event.shiftKey && !event.altKey) {
        const dir = event.ctrlKey || event.metaKey ? -1 : 1
        window.dispatchEvent(new CustomEvent('project:cycle', { detail: { dir } }))
        event.preventDefault()
        return
      }

      if (termFocused) {
        const insert = !!termMirror?.insert
        // Insert mode: keystrokes belong to the shell. Only Esc is ours.
        if (insert) {
          if (event.key === 'Escape') {
            setInsert(false)
            // Blur the xterm textarea so subsequent keys reach the window
            // handler (pane-op mode) rather than the shell.
            const ta = document.activeElement as HTMLElement | null
            ta?.blur?.()
            event.preventDefault()
            return
          }
          return // let xterm have everything else
        }

        // ----- Terminal pane-op (normal) mode -----
        const k = event.key
        const ctrl = event.ctrlKey || event.metaKey

        // C-w prefix: arm, then resolve h/j/k/l/w/q on the next key.
        if (pendingCw) {
          if (Date.now() - pendingCwAt <= CW_TIMEOUT_MS) {
            if (k === 'h' || k === 'j' || k === 'k' || k === 'l') {
              moveFocus(k)
              pendingCw = false
              event.preventDefault()
              return
            }
            if (k === 'w') {
              cyclePane()
              pendingCw = false
              event.preventDefault()
              return
            }
            if (k === 'q') {
              const { killPtyId, killBridgeId } = closeActivePane()
              if (killPtyId !== null) killPty(killPtyId)
              if (killBridgeId) invoke('claude_kill', { projectId: killBridgeId }).catch(() => {})
              pendingCw = false
              event.preventDefault()
              return
            }
          }
          pendingCw = false // expired / unmatched; fall through
        }
        if (ctrl && (k === 'w' || k === 'W')) {
          pendingCw = true
          pendingCwAt = Date.now()
          event.preventDefault()
          return
        }

        // RV3-B — a file-nav pane owns its own vim keys (j/k/h/l/Enter/g/G) via
        // a keydown handler on its focused tree root. In pane-op mode we must
        // NOT swallow those — let them bubble to the focused FileTree. Leader
        // (Space), C-w focus moves, and Esc are still handled here (above/below).
        if (termMirror?.activeIsFileNav && !ctrl) {
          const leaderArmed = !!(window as unknown as { __bsVim?: { leaderActive: boolean } })
            .__bsVim?.leaderActive
          const navKeys = ['j', 'k', 'h', 'l', 'g', 'G', 'Enter', 's', 'y']
          if (!leaderArmed && k !== ' ' && k !== 'Escape' && navKeys.includes(k)) {
            return // do not preventDefault — the FileTree's handler consumes it
          }
        }

        // i / Enter -> insert mode (hand keys to the shell, or the agent input)
        if ((k === 'i' || k === 'Enter') && !ctrl) {
          setInsert(true)
          // RV2 — an agent pane's <input> does not auto-focus like xterm; focus
          // it explicitly or the first keystroke is dropped (G2).
          if (termMirror?.activeIsAgent) {
            focusAgentInput(termMirror.activeAgentBridgeId)
          }
          event.preventDefault()
          return
        }

        // Leader (Space) opens the pane-op leader menu below via the shared
        // leader machinery — but in terminal focus the bindings differ, so
        // handle the leader-second-key here when leaderActive is set.
        const leaderNow = !!(window as unknown as { __bsVim?: { leaderActive: boolean } })
          .__bsVim?.leaderActive
        if (leaderNow && !ctrl) {
          setLeaderActive(false)
          if (leaderTimer !== null) {
            window.clearTimeout(leaderTimer)
            leaderTimer = null
          }
          // Esc cancels the leader menu without firing a pane command.
          if (k === 'Escape') {
            event.preventDefault()
            return
          }
          switch (k) {
            case 's':
              splitActive('h')
              event.preventDefault()
              return
            case 'v':
              splitActive('v')
              event.preventDefault()
              return
            case 't':
              newTab()
              event.preventDefault()
              return
            case 'z':
              toggleZoom()
              event.preventDefault()
              return
            case 'a':
              // RV2 — spawn a new agent pane on the active project (App.tsx
              // handles the event; keeps useVimNav decoupled from project state).
              window.dispatchEvent(new CustomEvent('agent:spawn'))
              event.preventDefault()
              return
            case 'e':
              // RV3-B — spawn a file-nav pane on the active project.
              window.dispatchEvent(new CustomEvent('filenav:spawn'))
              event.preventDefault()
              return
            case 'x': {
              const { killPtyId, killBridgeId } = closeActivePane()
              if (killPtyId !== null) killPty(killPtyId)
              if (killBridgeId) invoke('claude_kill', { projectId: killBridgeId }).catch(() => {})
              event.preventDefault()
              return
            }
            // Focus-out to other panes (keep global leader semantics so the
            // user isn't trapped in the terminal region).
            case 'b':
              setFocused('board')
              event.preventDefault()
              return
            case 'c':
              setFocused('chat')
              event.preventDefault()
              return
            case 'p':
              window.dispatchEvent(new CustomEvent('project:cycle'))
              event.preventDefault()
              return
            default:
              if (k >= '1' && k <= '9') {
                switchTab(Number(k) - 1)
                event.preventDefault()
                return
              }
              // Unknown terminal leader key — swallow.
              event.preventDefault()
              return
          }
        }
        if (k === ' ' && !ctrl) {
          // Persistent leader — no auto-dismiss (see the global activation).
          setLeaderActive(true)
          event.preventDefault()
          return
        }
        // gt / gT tab cycle
        if (k === 't' && event.shiftKey === false && !ctrl && pendingKey === 'g') {
          pendingKey = null
          cycleTab(1)
          event.preventDefault()
          return
        }
        if (k === 'T' && !ctrl && pendingKey === 'g') {
          pendingKey = null
          cycleTab(-1)
          event.preventDefault()
          return
        }
        if (k === 'g' && !ctrl) {
          pendingKey = 'g'
          pendingAt = Date.now()
          event.preventDefault()
          return
        }
        // Any other bare key in terminal-normal: swallow so it doesn't leak
        // to the board keymap or the shell.
        if (!ctrl && k.length === 1) {
          event.preventDefault()
          return
        }
        // Ctrl/meta combos and non-printing keys fall through to global.
      }

      // ----- Leader is a GLOBAL chord: if it's already armed, the next key
      // resolves as a leader command REGARDLESS of what element has DOM focus.
      // This runs BEFORE the editable-target bypass below, because an agent
      // pane's <input> (or the legacy chat input) holds real focus, and
      // without this the bypass would swallow the leader's second key and the
      // command would silently no-op (menu shows, nothing fires). Blur any
      // focused editable so the resolved command lands cleanly.
      {
        const vimNow = (window as unknown as {
          __bsVim?: { leaderActive: boolean; focused: string }
        }).__bsVim
        if (vimNow?.leaderActive && !(event.ctrlKey || event.metaKey || event.altKey)) {
          const editable = isEditableTarget(event.target)
          if (editable) {
            const el = document.activeElement as HTMLElement | null
            el?.blur?.()
          }
          // Fall through to the shared leader-resolution switch below by NOT
          // returning here; but we must ensure the editable bypass doesn't
          // eat it. Set a local flag the bypass checks.
          leaderChordActive = true
        } else {
          leaderChordActive = false
        }
      }

      // Bypass — typing into an editable surface; we have no business
      // here, the OS / xterm / input element owns the keystroke. EXCEPT when a
      // leader chord is mid-resolution (handled just above).
      if (isEditableTarget(event.target) && !leaderChordActive) return

      const key = event.key
      const hasMod =
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey

      // Read leader state from window mirror to avoid stale closure.
      const vim = (window as unknown as { __bsVim?: { leaderActive: boolean; focused: string } }).__bsVim
      const leaderActive = !!vim?.leaderActive
      const focused = (vim?.focused ?? 'board') as
        | 'sidebar'
        | 'board'
        | 'chat'
        | 'terminal'

      // ----- Leader sequence -----
      if (leaderActive) {
        if (leaderTimer !== null) {
          window.clearTimeout(leaderTimer)
          leaderTimer = null
        }
        setLeaderActive(false)
        // Esc cancels the leader menu without firing a command (LazyVim feel).
        if (key === 'Escape') {
          event.preventDefault()
          return
        }
        switch (key) {
          case 'p':
            window.dispatchEvent(new CustomEvent('project:cycle'))
            event.preventDefault()
            return
          case 'k':
            // Phase 9 — leader-k opens the command palette (mnemonic with the
            // Cmd+K chord). project:cycle stays on leader-p / Shift-Tab.
            openPalette()
            event.preventDefault()
            return
          case '\\':
            // leader-\ toggles the sidebar collapse (App owns the state).
            window.dispatchEvent(new CustomEvent('sidebar:toggle'))
            event.preventDefault()
            return
          case 'b':
            setFocused('board')
            event.preventDefault()
            return
          case 'c':
            setFocused('chat')
            event.preventDefault()
            return
          case 's':
            setFocused('sidebar')
            event.preventDefault()
            return
          case 'a':
            // RV2 — spawn a new agent pane (works from any focus).
            window.dispatchEvent(new CustomEvent('agent:spawn'))
            event.preventDefault()
            return
          case 'e':
            // RV3-B — spawn a file-nav pane (works from any focus).
            window.dispatchEvent(new CustomEvent('filenav:spawn'))
            event.preventDefault()
            return
          case 'q':
            event.preventDefault()
            void tryQuit()
            return
          default:
            // Unknown leader binding — swallow the key so it doesn't
            // also trigger a non-leader binding below.
            event.preventDefault()
            return
        }
      }

      // ----- Activate leader on bare Space -----
      // Persistent (LazyVim/which-key style): stays armed until a second key
      // resolves it or Esc cancels — no auto-dismiss timeout.
      if (key === ' ' && !hasMod) {
        setLeaderActive(true)
        event.preventDefault()
        return
      }

      // ----- Combo second-key resolution (g* / z*) -----
      // We resolve the second key BEFORE letting the regular bindings
      // fire so e.g. 'q' after 'g' doesn't get swallowed by anything
      // else, and 'g' after 'g' doesn't re-arm and then immediately
      // fall through to a no-op.
      if (pendingKey !== null && !hasMod) {
        const now = Date.now()
        const window_ms = pendingKey === 'g' && key === 'q' ? GQ_COMBO_TIMEOUT_MS : COMBO_TIMEOUT_MS
        if (now - pendingAt <= window_ms) {
          // gq — quit
          if (pendingKey === 'g' && key === 'q') {
            pendingKey = null
            event.preventDefault()
            void tryQuit()
            return
          }
          // gg — first row in sidebar
          if (pendingKey === 'g' && key === 'g' && focused === 'sidebar') {
            pendingKey = null
            dispatchSidebarCmd('first')
            event.preventDefault()
            return
          }
          // zR / zM — expand-all / collapse-all in sidebar.
          // R and M are uppercase; that means Shift was held, which
          // means the regular hasMod check would have rejected. So we
          // accept Shift specifically for the second key of a z-combo.
          // Re-check with the original event (which still has shiftKey).
          if (pendingKey === 'z' && focused === 'sidebar') {
            // Allow only Shift modifier; reject ctrl/meta/alt.
            if (!event.ctrlKey && !event.metaKey && !event.altKey) {
              if (key === 'R') {
                pendingKey = null
                dispatchSidebarCmd('expandAll')
                event.preventDefault()
                return
              }
              if (key === 'M') {
                pendingKey = null
                dispatchSidebarCmd('collapseAll')
                event.preventDefault()
                return
              }
            }
          }
        }
        // Fall through — combo expired or didn't match. Clear the
        // pending state and let the regular bindings handle this key.
        pendingKey = null
      }

      // ----- Arm combos -----
      if (key === 'g' && !hasMod) {
        pendingKey = 'g'
        pendingAt = Date.now()
        // Don't preventDefault — 'g' alone isn't bound and the page is
        // inert on it.
        return
      }
      if (key === 'z' && !hasMod) {
        // 'z' is only meaningful as a sidebar prefix today. Arm it
        // unconditionally (cheaper than gating); the second-key check
        // gates on focus.
        pendingKey = 'z'
        pendingAt = Date.now()
        return
      }

      // ----- Tab / Shift+Tab on board (allow shift modifier only) -----
      if (key === 'Tab' && focused === 'board' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const delta = event.shiftKey ? -1 : 1
        window.dispatchEvent(
          new CustomEvent('board:cursor', { detail: { delta, axis: 'horizontal' } }),
        )
        event.preventDefault()
        return
      }

      // ----- Shift+G on sidebar -> last row -----
      // 'G' arrives with shiftKey:true; that's the only modifier we
      // accept. We check this BEFORE the global hasMod gate below.
      if (key === 'G' && focused === 'sidebar' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        dispatchSidebarCmd('last')
        event.preventDefault()
        return
      }

      // From here on require no modifiers.
      if (hasMod) return

      // ----- j / k -----
      if (key === 'j' || key === 'k') {
        const delta = key === 'j' ? 1 : -1
        switch (focused) {
          case 'sidebar':
            window.dispatchEvent(new CustomEvent('sidebar:cursor', { detail: { delta } }))
            event.preventDefault()
            return
          case 'board':
            window.dispatchEvent(
              new CustomEvent('board:cursor', { detail: { delta, axis: 'vertical' } }),
            )
            event.preventDefault()
            return
          case 'chat':
            scrollChat(delta * 60)
            event.preventDefault()
            return
          default:
            return
        }
      }

      // ----- h / l -----
      if (key === 'h' || key === 'l') {
        if (focused === 'sidebar') {
          dispatchSidebarCmd(key === 'h' ? 'collapse' : 'expand')
          event.preventDefault()
          return
        }
        if (focused === 'board') {
          const delta = key === 'l' ? 1 : -1
          window.dispatchEvent(
            new CustomEvent('board:cursor', { detail: { delta, axis: 'horizontal' } }),
          )
          event.preventDefault()
          return
        }
      }

      // ----- Enter / o -> open -----
      if ((key === 'Enter' || key === 'o') && focused !== 'chat') {
        if (focused === 'sidebar') {
          dispatchSidebarCmd('open')
        } else {
          window.dispatchEvent(new CustomEvent('issue:open'))
        }
        event.preventDefault()
        return
      }

      // ----- / -> focus terminal (enters insert so typing works at once) -----
      if (key === '/') {
        setFocused('terminal')
        setInsert(true)
        focusXterm()
        event.preventDefault()
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (leaderTimer !== null) {
        window.clearTimeout(leaderTimer)
        leaderTimer = null
      }
    }
  }, [])
}
