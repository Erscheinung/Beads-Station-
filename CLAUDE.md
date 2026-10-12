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
| `opus-conductor` | Wired in 0.1.6 (`conductors.rs`): `claude --print --model opus` with an adaptive-orchestrator preamble; enabled when `claude`, the skill and its `sonnet-worker` agent exist in the workspace `.claude/` or `~/.claude/` (installed by `setup.sh` from https://github.com/Erscheinung/opus-sonnet-conductor, local checkout `~/Desktop/Code/opus-sonnet-conductor`). Command line and availability are tested; **no real run has been made**. `BS_OPUS_CONDUCTOR_DIR` only tells the "not installed" message where `setup.sh` is. |
| live session | The Designer's Session view; an attempt the user submits for review is recorded as provider `session` (`native_session_submit`). |

The older interval conductor (`conductor.rs`, Claude pulses, herdr bridge)
still exists; `Code-yfb` tracks durable leases/budgets. Finishing the Designer
end-to-end (request → conductor run → artifact → revision → approval in the
packaged app) is the top product priority.

## Todoist reconciliation — "Test 0.1.3 and release 0.1.4"

Status as of 2026-10-02 (v0.1.5 published); the 2026-10-12 round is in the v0.1.6 task list below. "Done" = implemented with automated evidence; items
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
| Repeated text while scrolling; scroll-up snaps to bottom | Snap fixed (user-intent follow). Repeats come from the provider TUI reprinting on every resize signal; v0.1.5 sends one native resize per settled size instead of one per layout callback. *Native check with streaming Claude/Codex* | `Code-da0.6`, `Code-t3w.7`, `Code-xni.6` |
| Can't drag and drop files | Done (paste quoted paths into the pane under the drop), *native Finder check* | `Code-da0.7` |
| Designer View → resizable elements | Done (nav + agents columns) | `Code-da0.8` |
| Designer View / conductor | Codex orchestrator real run verified at backend level (v0.1.5 fixed `codex exec` flag, `Code-am5.6`); packaged click-through is a *native check*; follow-ups `Code-am5.7` (.beads in artifacts), `Code-am5.8` (worker visibility) | `Code-da0.5`, `Code-am5`, `Code-yfb` |
| Terminal sessions don't persist / resume without tokens | Partly: a restored shell pane that had Claude/Codex in the foreground offers an explicit "Start shell and resume" (`claude --continue` / `codex resume --last`). Never automatic (launch-on-intent rule). Live process survival still open; exact per-pane session id is `Code-6un.3.1` | A3 `Code-6un.3`, `Code-xni.7` |
| LazyVim colors look different | Open | `Code-0cp.4` |
| Claude/Codex chat view redesign | Open (plan on second machine) | `Code-am5.5` |
| Auto-update like CMUX | Partly done in v0.1.5: release check (GitHub API, then the user's `gh` login while the repo is private), download + SHA-256 verify + open DMG. Replacing the running app is future work (needs Developer ID signing). *Native check* | `Code-xni.5`, `Code-t3w.2` |
| Notification in panes when done, optional auto-switch | Done in v0.1.5 (bell, OSC 9/99/777, agent turn end, quiet-after-work heuristic; ring, tab dots, Dock badge, `Cmd+Shift+U`). *Native check*. Follow-ups: system notifications `Code-my5`, panel `Code-s8b`, hook-based signals `Code-270` | `Code-xni.1` |
| Terminal shortcuts (Cmd-arrow, option-click, …) | Done in v0.1.5, *native check* | `Code-xni.2` |
| LazyVim icons / JetBrains Nerd Font default | Done in v0.1.5 (font bundled; WKWebView cannot see user fonts). *Native check* | `Code-xni.3` |
| Enter confirms destructive dialogs | Done in v0.1.5 | `Code-xni.4` |
| Embedded browser | Decision open | `Code-470` |
| Continuous DMG release + feedback | Open. v0.1.5 was built and published by hand on 2026-10-02 with browser-harness screenshots (the build session cannot capture the screen); CI workflow after | `Code-9ro` |
| Svelte migration | Future — see below | `Code-cuh` |
| Metrics/latencies for Rust comparison | Open | `Code-2mx` |
| Bundle beads with app? | Decision open | `Code-u6h` |
| Pi as subagent / session tree | Research open | `Code-j5v` |
| Herdr for pane management? | Not used for panes: only the conductor's optional herdr bridge; herdr CLI absent here. Evaluate under A3. | `Code-6un.3` |
| Custom instructions/context layer; tracker connector | Future | `Code-un1` |
| New icon | Open | `Code-f76` |

## v0.1.6 task list (Todoist round of 2026-10-12, epic `Code-gya`)

Source is at 0.1.6 in all three version files and committed. A local DMG was
built on 2026-10-12; **no tag or GitHub release exists yet**. Everything marked
done has automated evidence only and needs the hands-on pass in
`docs/releases/v0.1.6.md` before the Todoist items are ticked.

| # | Item | Status | Bead |
| --- | --- | --- | --- |
| 1 | Terminal-only view clips the bottom rows (Todoist P1, also "bottom part vanishes") | Done. `.bs-terminal-region` lacked `min-height: 0`, so it could never shrink below the xterm screen's pixel height. Live test fails without the fix | `Code-gya.1` |
| 2 | Focusing a pane/tab/fullscreen puts the cursor in the shell | Done (`typeIntoActiveShell`). Agent and file panes keep their own focus rules | `Code-gya.2` |
| 3 | Restored plain shell starts by itself | Done. Panes that hosted an agent (chat pane or agent CLI) still wait for an explicit resume | `Code-gya.3` |
| 4 | Shortcut recorder: Tab chords, macOS Control chords | Done. `Ctrl+…` is a separate modifier on macOS; Control+single key always reaches the shell; Command+Tab cannot be captured by any app (Settings says so) | `Code-gya.4` |
| 5 | Copy/paste | Partly: Cmd+C writes the selection directly, Option-drag selects inside mouse-capturing TUIs. "Wonky" needs a concrete repro from the user | `Code-gya.5` |
| 6 | Copy on select | Done, setting on by default | `Code-gya.6` |
| 7 | Terminal text size shortcuts | Done: `Mod+=`, `Mod+-`, `Mod+0`, rebindable | `Code-gya.7` |
| 8 | What's new after an update | Done: `src/state/whatsNew.ts` (`RELEASE_HIGHLIGHTS`, add an entry per release). Never shown on a first install | `Code-gya.8` |
| 9 | Open a folder from Finder | Done for Open With / Dock drop / `open -a` (`src-tauri/Info.plist`, `RunEvent::Opened`). "New Beads here" Quick Action not built | `Code-gya.9` |
| 10 | Designer live session | First slice done, see below | `Code-gya.10` |
| 11 | `.beads` files in Designer artifacts | Done | `Code-am5.7` |
| 12 | Terminal keeps 80x24 when its host never resizes after attach | Done: one re-fit a frame after attach (xterm measures its cell on first intersection) | `Code-gya.10` |
| 13 | Capture, approve and close a ticket from the Designer session | Done | `Code-cox` |
| 14 | Worker visibility in Designer runs | Done: collab items and Claude subagent lines are narrated; Codex worker rollouts are read on demand (`codex_thread_activity`) | `Code-am5.8` |
| 15 | Opus conductor | Wired, not run against a provider | `Code-am5.9` |
| 16 | Waiting-panes panel (`Mod+I`) | Done | `Code-s8b` |
| 17 | macOS Notification Center | Done (`tauri-plugin-notification`, setting off by default; permission asked when turned on) | `Code-my5` |
| 18 | Exact waiting/finished signals and session id from Claude Code | Done: `agent_hooks.rs`. Hooks write OSC 777 / OSC 7770 to `$BEADS_STATION_TTY`. App-started sessions use `claude --settings`; hand-typed `claude` needs the opt-in install into `~/.claude/settings.json` | `Code-270` |
| 19 | Exact session resume per pane | Done: Claude id from the hook, Codex id from its open rollout file (`lsof`) | `Code-6un.3.1` |
| 20 | Self-installing update | Done: prepare (download, SHA-256, bundle id/version/codesign, stage beside the bundle) then swap after quit. Swap tested on stand-in folders only | `Code-t3w.2` |
| 21 | Browser pane | Done as a sandboxed iframe plus a separate persistent window; native child web view is `Code-vjy` | `Code-470` |
| 22 | Terminals survive quitting the app | Done, **opt-in and off by default**: `pty_host.rs` | `Code-6un.3` |
| 23 | Repeated text while scrolling | No code change: Claude Code 2.1 and Codex 0.162 draw in the alternate screen, where the reprint cannot accumulate | `Code-xni.6` |

Still open from that Todoist round: memory profile vs cmux (`Code-2mx`, deferred
by the user), "New Beads here" Quick Action (`Code-xny`), saved screen above a
restarted shell (`Code-lgp`), per-prompt snapshots (`Code-n76`), native browser
web view (`Code-vjy`), a concrete repro for "copy/paste is wonky".

### Terminal host (kept terminals, `Code-6un.3`)

`src-tauri/src/pty_host.rs`. The app's own binary started with
`--pty-host <socket>` is a detached process that owns shells. `pty_spawn` takes
an optional `persistKey`; with one it attaches to that key in the host or
spawns there, and falls back to an in-process PTY if the host cannot be
reached. Rules that must hold:

- A pane's key (`Leaf.hostKey`) is a random UUID, saved before the shell
  starts, and known only to that pane and the host's memory. Nothing else may
  be used to find a shell; a dead host means an unknown key, never a guess.
- The wire protocol is versioned (`PROTOCOL = 1`) and changes must be additive:
  an updated app has to talk to a host an older version started.
- Replayed history is marked `replay` and must not raise notifications or let
  a queued startup command run (it would be typed into a live program).
- Attaching to a live shell is not launching an agent, so it needs no click.
  A restored agent pane checks `pty_persisted` first and only offers resume
  when its shell is gone.
- Explicit pane/workspace close kills the shell, including panes never shown
  this launch (`terminal:release-keys`). Quit leaves host shells running only
  while the setting is on.
- Not covered: logout, restart, shutdown, or the host being killed. Then the
  exact-session resume offer is the fallback.

### Designer live session (Napkin model)

`src/components/designer/SessionView.tsx` adds a **Session** item to the
Designer: the real `claude` / `codex` CLI (or a plain shell) in a terminal on
the left, and the workspace's changed files with per-file diffs on the right
(`artifact_preview`, the same bounded read as a capture, bound to no run and
never stored). A ticket's **Open in a live session** hands the ticket over; a
second click starts the CLI on it. Nothing starts on mount. The session's pane
id is `designer:<workspaceId>`; it lives outside the `termPanes` tree and is
disposed when the workspace closes.

This follows the user's own Napkin Claude app (`~/Desktop/Code/Napkin-Claude`,
Svelte 5 + Tauri): talk = real CLI in a PTY, ink spill = changed files. Next
slices, in order: (1) done in 0.1.6: capture, approve, request changes and
close ticket from the Session view; (2) per-prompt snapshots with erase/fold in a shadow git
repo, porting Napkin's `snapshot.rs` and its `claude --settings` hooks (which
also gives `Code-270` exact waiting signals); (3) the paper look as a Designer
theme. The older JSON chat (`ClaudeChat`) still exists beside it.

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
