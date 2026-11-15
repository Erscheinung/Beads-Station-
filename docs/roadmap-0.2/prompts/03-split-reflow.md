# [p2] Words shift after splitting a terminal

User report: "split windows get weird shifted words". After a split, the existing pane shows text reflowed wrongly or drawn at the old width until the next output.

## Where to look

`src/lib/terminalSessions.ts`: `resize()` (about line 720), the coalesced native resize (`pty_resize`, comment near line 71 "A drag or window resize reports many intermediate sizes"), the one re-fit a frame after attach, and `requestNativeRedraw`. `src/components/Terminal.tsx` owns the ResizeObserver. v0.1.5 deliberately sends one native resize per settled size; a split changes the size twice (mount, then ratio), so the settled size may be sent before the second layout.

## What to do

1. Reproduce in the harness first: `tests/live/layout.spec.ts` and `tests/live/terminal-lifecycle.spec.ts` show how to read `inspectTerminalSession` (xterm cols/rows against the native size). Write a failing live test: split right, wait for layout to settle, assert xterm cols equal the last `pty_resize` cols for both panes and that the container width matches cols times cell width within one cell.
2. Fix the cause (likely a missing fit after the split animation frame, or a resize dropped by the coalescer when the size returns to a previous value).
3. Agent TUIs redraw on SIGWINCH; a plain shell does not reflow old lines. Say so in the hands-on list rather than trying to rewrite scrollback.

## Acceptance

- The new live test fails before and passes after.
- `npx vitest run src/lib/terminalSessions.test.ts` passes, including "native resize coalescing".

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
