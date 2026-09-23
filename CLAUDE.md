# Beads Station — agent workflow

Beads Station is a lightweight Tauri 2 (Rust + React/xterm) macOS daily driver
meant to replace a CMUX + Neovim/LazyVim workflow while keeping Beads tickets,
visible agent work, review gates and a conductor. Developers get a
terminal-first workspace; designers get an outcome-first request → run →
artifact → review flow over the same runs.

Read order: this file, `AGENTS.md` (handoff history and orchestration
contract), then `docs/roadmap-0.2/MASTER-PLAN.md`. Older plans,
`BEADS-CONTEXT.md` and historical handoffs describe earlier machines and states;
current source, reproduced behavior and the current user's scope win.

## Identity and privacy (every commit)

- Commit identity is **machine-local**. Before committing, read the gitignored
  `CLAUDE.local.md` if present and run `git config user.email` to confirm it
  matches. Never change identity in tracked files or rewrite another machine's
  commits.
- Never write an employer name, work username, internal hostnames/URLs, internal
  project names, or `/Users/<name>` paths into tracked files, commit messages,
  beads fields or screenshots. Use `~`, generic names (`sample-project`,
  "second machine", "LLM gateway") and redact screenshots before committing.
- private integrations (internal auth MCPs, internal tool suites) are
  documented only on the second machine, never here.
- Built installers (`*.dmg`) belong in GitHub Releases, not git.

## Before tracker writes

```sh
git config --get beads.role   # must be maintainer; set it if absent
bd where                      # must resolve to this repo's .beads
bd prime
```

Use `bd` for all tracking. Create or reconcile an issue before code changes,
claim it, and read it back. Use `bd update`, never interactive `bd edit`.
Do not hand-edit Dolt files or `.beads/*.jsonl` exports.

```sh
bd ready
bd show <id>
bd update <id> --claim
bd close <id> --reason 'Implemented and verified ...'
```

## Product constraints (from AGENTS.md)

- Discovery is not opening: scans populate a picker; only explicitly opened
  workspaces are restored. Suggested root `~/Desktop/Code`, configurable.
- Native Claude/Codex CLI login is the default. A gateway profile is optional
  and explicit (`BS_AUTH_PROFILE=gateway`, `.env`). Never inspect, print, copy
  or commit credentials.
- Launch agents on intent only — never on mount, discovery, restore or config
  reads. No hidden model turns; unknown usage stays unknown; cancel is not
  completion; approval binds to one run + artifact revision.
- Keep real Neovim/LazyVim and the user's config; app keys must not steal
  editor keystrokes (Cmd/Ctrl+P leader and Escape are protected).
- Meta-priorities: hardware efficiency and speed; terminal process, screen,
  scroll anchor and focus survive navigation. A saved layout is not a live
  process.
- Designers must be able to finish a ticket without a terminal.

## Verification and release

Gates for implementation changes: `npm run build`, `npm test`,
`npm run test:live` (Chromium + mock IPC), `cargo check --manifest-path
src-tauri/Cargo.toml --quiet`, and `cargo test` for Rust changes, plus
`git diff --check`. Mock/browser tests do not prove native PTY, WKWebView,
auth or process survival — record native evidence separately.

Releases follow SemVer `0.x` tags (`vMAJOR.MINOR.PATCH`): PATCH for fixes,
MINOR for new capability. Keep versions in sync across `package.json`,
`src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`. Prereleases until the
Designer workflow is functional. Never move a published tag except under an
explicit user-authorized history rewrite; otherwise ship a higher patch.
Every release needs install steps, SHA-256, works/doesn't-work, a test
checklist and screenshots from that exact build.

Durable user config lives in
`~/Library/Application Support/ai.beads-station.desktop/user-preferences.json`
(allowlist in `src/lib/durableUserConfig.ts`).

## Orchestration

Codex model/role assignments live in `~/.codex/config.toml` and
`~/.codex/agents/*.toml` (Sol primary, Luna `worker`, `sol_worker` fallback);
the global `adaptive-orchestrator` skill comes from
https://github.com/Erscheinung/codex-astra-luna-orchestrator (local checkout
`~/codex-astra-luna-orchestrator`). Adaptive routing, not a fixed pipeline;
one bounded worker for small work; no automatic reviewer. Write subagent
prompts as complete, human-readable briefs.

## Designer conductor

Designer ticket runs (`native_run_start`, `src-tauri/src/claude.rs`) choose a
backend in the request panel:

| Backend | Status |
| --- | --- |
| Claude / Codex direct | Working via native CLI login |
| `codex-orchestrator` | Working (`src-tauri/src/conductors.rs`): `codex exec` with an adaptive-orchestrator preamble; enabled when `codex` and the skill (workspace `.agents/skills/…` or `~/.codex/skills/…`) exist. One real run verified 2026-09-23 via the opt-in `live_designer_run_reaches_review_and_binds_approval` Rust test (needs_review → capture → stale detection). Packaged WKWebView click-through still unexercised. |
| `opus-conductor` | **Placeholder.** Detection only via `BS_OPUS_CONDUCTOR_DIR`; never launches. The Opus conductor lives in a private repo on the second machine — wire its launch contract in `conductors.rs` + `native_run_start` there. |

The older interval conductor (`conductor.rs`, Claude pulses, herdr bridge)
still exists; `Code-yfb` tracks durable leases/budgets. Finishing the Designer
end-to-end (request → conductor run → artifact → revision → approval in the
packaged app) is the top product priority.

## Todoist reconciliation — "Test 0.1.3 and release 0.1.4"

Status as of 2026-09-23 (v0.1.5 draft). "Done" = implemented with automated evidence; items
marked *native check* still need a hands-on packaged-app test before ticking.

| Todoist item | Status | Evidence / bead |
| --- | --- | --- |
| Version number in About | Done | `Code-t3w.1` |
| Close pane should confirm; confirm destructive ops | Done | `Code-t3w.3` |
| No need to click "Open folder" after Finder | Done | `Code-t3w.5` |
| Focus terminal gives no cursor/interaction | Done | `Code-t3w.6` |
| Updating app preserves everything (keybindings/config) | Done, *native DMG→DMG check* | `Code-t3w.4` |
| Open workspace: find folders easier | Done, *native check* | A4 `Code-6un.4` |
| Init beads from board/explorer + keybinding | Done, *native check* | A5 `Code-6un.5` |
| Drag/switch terminal tabs; switch in fullscreen | Done, *native check* | A6 `Code-6un.6` |
| Record custom named interaction + keybinding | Done, *native check* | A7 `Code-6un.7` |
| Bottom part vanishes in terminal | Fixed in source, *native check* | A1 |
| Switching tabs scrolls chat to top / loses cursor | Chat dedup + focus fixed; *native check* | `Code-t3w.6`, `Code-t3w.7` |
| Repeated text while scrolling; scroll-up snaps to bottom | Snap fixed (user-intent follow); repeats come from the provider TUI reprinting after clearing scrollback. *Native check with streaming Claude/Codex* | `Code-da0.6`, `Code-t3w.7` |
| Can't drag and drop files | Done (paste quoted paths into the pane under the drop), *native Finder check* | `Code-da0.7` |
| Designer View → resizable elements | Done (nav + agents columns) | `Code-da0.8` |
| Designer View / conductor | Codex orchestrator real run verified at backend level (v0.1.5 fixed `codex exec` flag, `Code-am5.6`); packaged click-through is a *native check*; follow-ups `Code-am5.7` (.beads in artifacts), `Code-am5.8` (worker visibility) | `Code-da0.5`, `Code-am5`, `Code-yfb` |
| Terminal sessions don't persist / resume without tokens | Open (saved-layout restore only) | A3 `Code-6un.3` |
| LazyVim colors look different | Open | `Code-0cp.4` |
| Claude/Codex chat view redesign | Open (plan on second machine) | `Code-am5.5` |
| Auto-update like CMUX | Future, plan only | `Code-t3w.2` |
| Continuous DMG release + feedback | Open. Decision 2026-09-23: finish the Designer end-to-end run first, then ship v0.1.5 by hand (done as a draft pending screenshots); CI workflow after | `Code-9ro` |
| Svelte migration | Future — see below | `Code-cuh` |
| Metrics/latencies for Rust comparison | Open | `Code-2mx` |
| Bundle beads with app? | Decision open | `Code-u6h` |
| Pi as subagent / session tree | Research open | `Code-j5v` |
| Herdr for pane management? | Not used for panes: only the conductor's optional herdr bridge; herdr CLI absent here. Evaluate under A3. | `Code-6un.3` |
| Custom instructions/context layer; tracker connector | Future | `Code-un1` |
| New icon | Open | `Code-f76` |

## Future: Svelte migration (`Code-cuh`)

Migrate the React/TSX frontend to Svelte 5 **incrementally and in readable,
hand-editable code** so the user can maintain it directly: plain components,
no generated/minified output, short comments on non-obvious lifecycle and IPC.
Keep the Tauri IPC contract, xterm session ownership (`src/lib/terminalSessions.ts`)
and the Vitest + Playwright mock-IPC harness working surface by surface. Start
with a written assessment (bundle/render cost, xterm integration, test
portability). Not a release prerequisite; start only on explicit go-ahead.

## Session constraints

The user often runs Claude Code inside the installed `/Applications/Beads Station.app`.
Never install over, quit or relaunch it, and never trigger macOS permission prompts
(System Events scripting, screen capture): put packaged-app checks in a hands-on
checklist instead. Run only the tests relevant to the change; full gates once per release.

## Handoff

Preserve pre-existing user changes. Do not recreate the previous laptop's
Obsidian mirror or daily folders. Push only with authorization. End with
changed behavior, checks actually run, remaining limitations and a concrete
next step. Keep `AGENTS.md` and this file current.
