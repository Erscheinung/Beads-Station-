# [p3] A path is shown with hex or escape codes

User report: "path shows some hex". No screenshot text was available in the session that wrote this. Likely places: the pane header (`terminal · <cwd>` in `src/components/TerminalPanes.tsx`), the statusline (`src/components/Statusline.tsx`), History titles, the workspace picker, or a Claude project folder name (`~/.claude/projects` encodes non-alphanumerics as `-`). Percent-encoding (`%20`), OSC 7 `file://` URLs and `\x1b` sequences are the usual sources.

## What to do

1. Ask the user for the on-screen text, or reproduce with a folder whose name has a space, a non-ASCII letter and a `#`.
2. Grep for places that render a path without `abbreviatePath` (`src/lib/abbreviatePath.ts`) and for any `encodeURI` / `file://` handling.
3. Decode for display only; never change the path that is passed to a command.

## Acceptance

- A unit test with `~/My Projects/café #2` for each renderer that was wrong.

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
