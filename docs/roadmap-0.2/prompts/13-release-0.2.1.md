# [p4] Prepare the 0.2.1 release notes and screenshots

Only when the owner asks for a release. The 0.2.1 work is on `next/0.2.1`; version files still say 0.2.0.

## What to do

1. Write `docs/releases/v0.2.1.md` from `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` section 4, with install steps, works / does not work, and the hands-on results from `HANDS-ON-0.2.1.md`.
2. Add a `RELEASE_HIGHLIGHTS` entry in `src/state/whatsNew.ts`: restored panes read as conversations, the top bar and launchers, `Mod+Shift+D` and `Mod+Y`, Command+click opens files in the editor, the browser pane moved to `Mod+Shift+B`.
3. Regenerate README screenshots: `BS_SHOTS=<folder> npx playwright test readme-shots` (labels changed: "Pinned", the new top bar).
4. Bump the three version files together, run the full gates once, and follow the two-repository procedure in `CLAUDE.md`. No tag or push without the owner confirming that exact version.

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
