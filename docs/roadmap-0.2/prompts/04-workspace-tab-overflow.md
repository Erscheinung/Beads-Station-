# [p2] Workspace tabs need an overflow menu

With many workspaces open, `src/components/TabBar.tsx` scrolls sideways (`overflowX: auto`) and tabs disappear off the edge with no hint.

## What to build

- When the strip overflows, show a chevron button at its right end that opens a list of all workspaces (name, a dot when a pane is waiting), newest-used first, with type-to-filter. Choosing one selects it and scrolls its tab into view.
- Keep drag reorder (`src/lib/pointerDrag.ts`) and `Mod+1..9` working. The active tab is always scrolled into view when it changes.
- No new dependency; measure overflow with a ResizeObserver on the strip only.

## Acceptance

- Live spec: open 12 mock workspaces (see how `tests/live/workspace-picker.spec.ts` seeds `beads-station.workspaces.v2`), assert the chevron appears, pick the last workspace from the menu, assert its tab is visible and selected.
- No chevron with two workspaces.

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
