# [p2] The Designer Session should know its conversation and show usage

Terminal panes learn their Claude or Codex session id (`pty_foreground`, hooks) and show `SessionUsageChip`. The Designer Session terminal (`designer:<workspaceId>`, `src/components/designer/SessionView.tsx`) lives outside the `termPanes` tree, so `setPaneAgentSession` finds no leaf and the id is dropped.

## What to build

- A small store for sessions of panes outside the tree (keyed by pane id), written from the same two places in `src/lib/terminalSessions.ts` (`observeForeground`, the OSC 7770 handler).
- `SessionView` reads it: shows `SessionUsageChip`, and a "Read in History" link that opens that exact conversation (`requestHistoryFocus` + `openDesignerView`).
- When the session ends, offer "Continue this conversation" on the empty state, using the remembered id. A click, never automatic.

## Acceptance

- Vitest for the store and for `terminalSessions` reporting a session for a pane id that is not in the tree.
- Live: `tests/live/designer-session.spec.ts` gains a case where the mock `pty_foreground` returns a Claude id and the chip appears.

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
