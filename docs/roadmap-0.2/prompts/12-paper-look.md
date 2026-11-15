# [p4] Conversation look: the paper theme

History and restored panes now read as a conversation (your messages as cards on the right, agent prose on the left: `src/components/designer/ConversationView.tsx`). The owner wants the look of their Napkin app (`~/Desktop/Code/Napkin-Claude/docs/DESIGN.md`): quiet paper, graphite ink (`#35322e`, never pure black), hand underlines for section labels, short soft shadows.

## What to build

- A Designer theme, not a rewrite: CSS variables scoped to `.bs-designer` in `src/theme/designer-light.css` plus a `data-look="paper"` switch in Settings → Appearance.
- Only principles that cost nothing at runtime: colours, type, borders, one tiled paper texture under 20 KB. No per-element filters, no canvas grain (hardware efficiency is a meta-priority).
- Terminals keep their own palette.

## Acceptance

- `tests/live/readme-shots.spec.ts` gains a paper-look capture from the sample project.
- Contrast of body text on paper is at least 7:1.

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
