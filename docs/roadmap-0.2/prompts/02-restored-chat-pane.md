# [p2] Restored chat panes should read as conversations too

Terminal panes that hosted the Claude or Codex CLI now restore as a searchable conversation with a message box (`src/components/RestoredPane.tsx`). Panes created by "New Claude agent pane" (the older JSON chat, `leaf.agent`) still restore as a grey card that says "Saved Claude session" with two buttons (`AgentPaneLeaf` in `src/components/TerminalPanes.tsx`, look for `data-restored-provider`).

## What to build

- When a restored chat pane has a provider-observed session id (`observedProviderSession`), show the same conversation body as `RestoredPane` (extract the shared reader into one component rather than copying it): header with provider, saved time and usage; search; "Show earlier turns".
- One primary action, "Continue", which also fires on Enter; "Start new session" as the secondary action. Nothing starts before that.
- With no observed id, keep the current card but say what to do next in one sentence.

## Files

`src/components/TerminalPanes.tsx`, `src/components/RestoredPane.tsx`, `src/components/designer/ConversationView.tsx`, `src/components/designer/transcripts.ts`, `src/state/sessionPreferences.ts`.

## Acceptance

- Vitest: extend "renders restored provider context without mounting a provider adapter" in `TerminalPanes.test.tsx`: the conversation is shown, `ClaudeChat` is not mounted and no `claude_start` / `codex_chat_start` is invoked until Continue.
- Live: a seeded restored chat pane shows turns from the mock `transcript_read`.

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
