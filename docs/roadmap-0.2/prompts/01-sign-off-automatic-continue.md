# [p1] Decide whether "Continue agent sessions automatically" ships

The 0.2.1 working tree adds an opt-in setting (Settings → Sessions, off by default) that reopens Claude or Codex in a restored pane as soon as the pane is shown, when its exact conversation is known. It is a deliberate exception to the launch-on-intent rule and needs the owner to say yes or no.

## What to do

1. Run `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` sections A and B in the packaged app and write the results into that file.
2. Measure the cost of reopening: follow the header of `scripts/resume-cost-snapshot.mjs` for one Claude and one Codex session, and note what `/cost` or `/status` says for the same minute. Record the numbers in `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` section 2.1.
3. If the owner approves: update the launch-on-intent line in `CLAUDE.md` and `AGENTS.md` to name the exception, and rewrite the setting text in `src/components/SettingsPanel.tsx` with the measured cost. If not: remove `autoResumeAgents` from `src/state/sessionPreferences.ts`, `shouldAutoResumeAgents`, the effect in `src/components/RestoredPane.tsx`, the settings row, and the two tests that cover it (`TerminalPanes.test.tsx`, `tests/live/holistic-upgrade.spec.ts`).

## Acceptance

- The setting text states a measured fact or the setting is gone.
- `npx vitest run src/components/TerminalPanes.test.tsx` and `npx playwright test tests/live/holistic-upgrade.spec.ts` pass.

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
