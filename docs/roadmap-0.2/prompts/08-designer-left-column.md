# [p3] Decide what the Designer left column is for

After 0.2.1 the Designer views live in the top bar. The left column now lists open workspaces and the tier card. It costs 220 px on every view.

## What to do

Audit each Designer view at 1280 px wide and choose one, with a short written reason in `docs/DESIGNER-DESK.md`:

1. Remove the column; put the workspace name in the purpose line as a menu and the tier in the top bar (already there).
2. Keep it and make it earn its width: workspaces with waiting dots, the usage meter (now buried at the bottom of History), and the ticket handed to Session.

Also in this pass: the right column (gates, sensors, conductor, agents) should collapse to a 28 px rail with a count badge when it has nothing to show, and the view heading inside each view repeats the new purpose line (remove one).

## Files

`src/components/designer/DesignerShell.tsx`, `designerLayout.ts`, `ColumnResizer.tsx`, `HistoryView.tsx` (`MeterCard`), `tests/live/designer-resize.spec.ts`.

## Acceptance

- `designer-resize.spec.ts` updated and passing; no view shows a horizontal scrollbar at 1280 px; first-run text for each view is one sentence plus one next action.

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
