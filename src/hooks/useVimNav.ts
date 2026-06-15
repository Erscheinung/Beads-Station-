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
//   h / l             — cursor left/right when board is focused
//   Tab / Shift+Tab   — column nav when board is focused
//   Enter / o         — open issue (focused !== chat)
//   /                 — focus the terminal
//   gq (within 700ms) — quit, with confirm
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

export function useVimNav(): void {
  useEffect(() => {
    let leaderTimer: number | null = null
    let lastGTime = 0

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

      // ----- gq combo (g then q within 700ms) -----
      if (key === 'g' && !hasMod) {
        lastGTime = Date.now()
        // Don't preventDefault — 'g' alone isn't bound and we want the
        // page to remain inert on it. It's harmless either way.
        return
      }
      if (key === 'q' && !hasMod && Date.now() - lastGTime <= GQ_COMBO_TIMEOUT_MS) {
        lastGTime = 0
        event.preventDefault()
        void tryQuit()
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

      // ----- h / l on board -----
      if ((key === 'h' || key === 'l') && focused === 'board') {
        const delta = key === 'l' ? 1 : -1
        window.dispatchEvent(
          new CustomEvent('board:cursor', { detail: { delta, axis: 'horizontal' } }),
        )
        event.preventDefault()
        return
      }

      // ----- Enter / o -> open issue -----
      if ((key === 'Enter' || key === 'o') && focused !== 'chat') {
        window.dispatchEvent(new CustomEvent('issue:open'))
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
