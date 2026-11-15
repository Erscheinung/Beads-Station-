# [p3] Small open items: saved-screen last line, per-day Codex usage, Gemini history

Three independent small fixes; do them as separate commits.

1. **Saved screen hides its last line.** `.bs-saved-screen` in `src/components/TerminalPanes.css`. In the restored pane the raw screen (`Show saved screen`) can end under the scrollbar or the composer. Add bottom padding equal to one line, keep `overflow: auto`, and test in `tests/live/holistic-upgrade.spec.ts` that the last line box is inside the scroller after scrolling to the end.
2. **Per-day Codex usage.** `src-tauri/src/meter.rs` reports Claude tokens per day but only the rate-limit windows for Codex. Rollouts carry `total_token_usage` running totals; a day figure is the difference between the last total of each session on that day and its first. Add `codex_days` to `Meter` (additive), a Rust test with two fixture rollouts across midnight, and a second row of bars in `MeterCard` (`HistoryView.tsx`). Unknown stays unknown: no dollar figures.
3. **Gemini in History.** The top bar can start Gemini, but `src-tauri/src/transcripts.rs` reads only Claude and Codex. Find where the Gemini CLI stores sessions (do not guess: inspect a real install), and add it read-only behind the same bounded reads, or write down that it stores nothing readable.

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
