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
// All non-passthrough handled keys preventDefault to avoid the page
// scrolling on Space, Tab focus-traversal, etc.

import { useEffect } from 'react'
import { setFocused, setLeaderActive } from '../state/vim'

const LEADER_TIMEOUT_MS = 1000
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

    const onKeyDown = (event: KeyboardEvent) => {
      // Bypass — typing into an editable surface; we have no business
      // here, the OS / xterm / input element owns the keystroke.
      if (isEditableTarget(event.target)) return

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
        switch (key) {
          case 'p':
            window.dispatchEvent(new CustomEvent('project:cycle'))
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
      if (key === ' ' && !hasMod) {
        setLeaderActive(true)
        if (leaderTimer !== null) window.clearTimeout(leaderTimer)
        leaderTimer = window.setTimeout(() => {
          setLeaderActive(false)
          leaderTimer = null
        }, LEADER_TIMEOUT_MS)
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

      // ----- / -> focus terminal -----
      if (key === '/') {
        setFocused('terminal')
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
