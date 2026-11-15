# [p3] A leader layer for places (Space g …)

Views are reachable from the top bar, the palette, `Mod+Shift+D` and `Mod+Y`. For a Neovim hand, a which-key layer is more natural: `Space g t` Terminal, `g r` Requests, `g s` Session, `g h` History, `g p` Pinned, `g m` Bead map, `g a` Agents.

## Where

`src/hooks/useVimNav.ts` owns the leader state machine; `LEADER_SHORTCUTS` in `src/state/commands.ts` feeds `src/components/WhichKey.tsx` and Settings. `openDesignerView` is in `src/state/designerNav.ts`.

## What to build

- A second-level table for `g`, shown by WhichKey after `Space g`, with a short timeout and Escape to cancel.
- It must work from the Designer skin as well as the Terminal one, and must not fire while an input or xterm has focus unless the leader was armed with Command/Control+P.

## Acceptance

- `src/hooks/useVimNav.test.tsx` cases for each chord, for cancel, and for "typing g in a field types g".
- The cheat sheet (`ShortcutSheet.tsx`) lists the layer.

## Product rules (do not break)

- Read `CLAUDE.md`, then `AGENTS.md`, then `docs/roadmap-0.2/HOLISTIC-UPGRADE.md` before touching code.
- Agents start on an explicit action only: never on mount, discovery, restore or a config read. The one exception is the opt-in "Continue agent sessions automatically" setting.
- Never press Enter for the user in an agent prompt. Typing into a pane is allowed; submitting is not.
- Command/Control+P (leader) and Escape belong to the editor. Check `RETIRED_DEFAULTS` in `src/state/commands.ts` before changing a default shortcut.
- Use `~` instead of home paths; no employer, account or machine names in tracked files, commit messages or beads.
- Do not install over, quit or launch the installed app. Do not push. Use `bd` for tracking (create and claim an issue first).
- Run only the focused tests for what you change, then `npm run build`. Mock tests do not prove native behaviour: add a hands-on line to `docs/roadmap-0.2/prompts/HANDS-ON-0.2.1.md` for anything a mock cannot show.
