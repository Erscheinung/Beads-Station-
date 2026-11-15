# [p2] Local pages blank in the browser pane: native web view

Tracked as `Code-vjy`. The browser pane is a sandboxed iframe (`src/components/BrowserPane.tsx`). 0.2.1 added a probe that tells "nothing is answering" from "refuses framing", and a hint with an "Open it in a window" button for plain-http pages. If the hands-on pass confirms that `http://localhost:<port>` is blank in the packaged app while the dev server is running, the frame is being blocked as mixed content and the real fix is a native child web view.

## What to do

1. Confirm the cause in the packaged app (hands-on list, section F). If local pages load, close this as not needed.
2. Otherwise build the pane on a Tauri child webview positioned over the pane rectangle: create on mount, reposition on layout change, hide when the pane is hidden by zoom or tab switch, destroy on close. It must get no IPC capability (see the comment at the top of `src-tauri/src/browser.rs`).
3. Keep the iframe path for the mock harness.

## Acceptance

- Rust tests for URL validation still pass; a new test proves the child webview label is not in any capability file.
- Hands-on: a Vite dev server on localhost renders in the pane, survives split and zoom, and is gone after the pane closes.

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
