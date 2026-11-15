# [p3] Pin from a terminal selection, and reorder pins

"Pinned" (code name Shelf, `src/components/designer/shelf.ts`, `ShelfView.tsx`) is filled from History or by pasting. The fastest source is missing: text selected in a terminal pane.

## What to build

- A command "Pin terminal selection" (palette, bindable, unbound by default) that adds the active pane selection as a note with source "Terminal". Read the selection through `src/lib/terminalSessions.ts`.
- A per-item "Type into agent" button so one pin is one click, without the tick boxes.
- Drag to reorder with `src/lib/pointerDrag.ts`; order is saved with the items.
- Storage stays per workspace in localStorage; say so on screen in one muted line.

## Acceptance

- `deskLogic.test.ts`: order survives reload; duplicate text is not added twice.
- Live: select text in the mock terminal is not possible, so cover the command with a unit test and add a hands-on line.

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
