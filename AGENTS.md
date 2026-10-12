# Beads Station — agent handoff

## Active work — 2026-10-02, second Todoist pass and v0.1.5 publication

Epic `Code-xni` (all seven children closed). Built on the unpublished v0.1.5
draft and published it. New: pane notifications (`src/state/paneNotifications.ts`,
sources in `src/lib/terminalSessions.ts`: bell, OSC 9/99/777, quiet-after-work,
agent turn end) with ring, tab/workspace dots, Dock badge, jump command and an
auto-switch setting that waits for a typing pause; macOS editing chords
(`src/lib/terminalKeys.ts`); bundled JetBrainsMono Nerd Font as the fallback in
every terminal font stack (WKWebView cannot see user-installed fonts); Enter/Escape
in both confirmation dialogs; release check and DMG download
(`src-tauri/src/update.rs`, `BS_UPDATE_REPO` overrides the repository; falls back
to the user's `gh` login while the repo is private); one native resize per settled
size; and an explicit "resume Claude/Codex" action on restored shell panes
(`pty_foreground`). New commands default to no shortcut when the user already uses
that chord. Follow-ups: `Code-my5`, `Code-s8b`, `Code-270`, `Code-6un.3.1`,
`Code-470`; self-replacing update stays in `Code-t3w.2`. Five Playwright specs
raced the app's async event subscription and failed on unchanged code; they now
wait for the reaction (`emitUntil` in `tests/live/helpers.ts`). None of the new
behaviour was run in the packaged app: the checklist in
`docs/releases/v0.1.5.md` is the user's hands-on list, and the release
screenshots are from the Chromium harness, labelled as such.

## Active work — 2026-09-23, Designer conductor run and v0.1.5

User decision: finish the Designer end-to-end run first, then cut v0.1.5 by hand
(`Code-9ro` CI later). `codex exec` 0.155 rejects `--ask-for-approval`, so every
Codex/orchestrator Designer run died at spawn; fixed with `-c approval_policy="never"`
and a unit-pinned `native_run_args`/`spawn_native_child` (`Code-am5.6`). One
authorized real `codex-orchestrator` run through the opt-in Rust test
`live_designer_run_reaches_review_and_binds_approval` reached `needs_review` and
proved capture, recapture and stale detection (see `docs/releases/v0.1.5.md`). The
agent closed its own ticket, so the Designer prompt now forbids that. Follow-ups:
`Code-am5.7` (.beads files in artifacts), `Code-am5.8` (worker thread visibility).
Release bundles are now ad-hoc signed by config (`Code-t3w.9`). This session could
not script or screenshot the packaged app (no Accessibility/Screen Recording, and
the user runs Claude inside the installed app — never replace or quit it), so the
WKWebView click-through and exact-build screenshots are the user's hands-on steps.
`Code-am5.2` is closed per the v0.1.3 notes but reads open in beads; reconcile it.

## Active work — 2026-09-23, repository hygiene and Todoist 0.1.x pass

Epic `Code-da0`. Identity is now machine-local (gitignored `CLAUDE.local.md`);
employer/machine references were scrubbed from files, beads data and — with the
user's explicit authorization — rewritten git history (all authors normalized,
branches and tags force-pushed). Implemented: user-intent terminal scroll
anchoring (`Code-da0.6`), native file drop into terminals (`Code-da0.7`),
resizable Designer columns (`Code-da0.8`), and Designer conductor backends —
Codex adaptive orchestrator plus an Opus placeholder (`Code-da0.5`). The
Todoist reconciliation table and the future Svelte migration task live in
`CLAUDE.md`. Native packaged checks for these remain open.

## Active work — 2026-09-23, post-v0.1.3 fixes

The user authorized installation of released v0.1.3 and implementation of six
bounded fixes, with focused checks and a checkpoint commit per completed item.
See [the active fix record](docs/POST-0.1.3-FIXES.md) and Beads epic `Code-t3w`.
User subsequently requested v0.1.4 release, README update, push/publication,
and no further subagents. Commit identity is machine-local (see `CLAUDE.md`).
Auto-update is future-only; its release endpoint design must accommodate the
user's two remotes (only `origin` is configured in this checkout). v0.1.4 publication is authorized. Preserve local configuration and existing sessions.
The orchestration no-review contract applies; workers own focused validation.

## Latest handoff — 2026-09-20, Designer artifact review slice

Roadmap B3 artifact/revision work is implemented under `Code-am5.2`; the bead is
closed, while B1 durable orchestration, B2 harness profiles, the remainder of B3,
and packaged real-provider acceptance remain open. The implementation was delegated
to Luna, then reviewed and corrected by the primary agent as explicitly requested.

- Designer request detail can capture, recapture, inspect, and locally approve an
  exact artifact revision after the authoritative native run reaches
  `needs_review`. Manifest identity includes workspace, ticket, run, attempt, source
  Git revision, relative paths, content hashes, and capture time.
- Rust owns an atomic app-data ledger and revalidates both native-run identity/cwd
  and current workspace hashes before approval. A new run cannot race capture or
  approval. Browser state is only a lightweight cache and reconciles from Rust.
- Supported captures are deliberately bounded to 256 UTF-8 files, 256 KiB per file,
  and 4 MiB total frozen content. Traversal, changed symlinks, binary files, oversized
  content, oversized status output, and incomplete manifests fail instead of being
  silently approved. Text/diff previews are escaped inert content; no project HTML
  executes with Tauri privileges.
- Revision feedback is retained, a new attempt invalidates the prior actionable
  approval, stale or mutated artifacts are rejected, and approval is local only: it
  does not publish, merge, post, or start a model. No independent validation result
  is fabricated when the run supplies none.

Evidence: full Vitest `222/222`, full Rust `116/116`, full Chromium/mock `78/78`,
production build, Cargo check, focused artifact/native-run suites, debug macOS app
bundle, and `git diff --check` passed. No provider/auth/credential work call or push
was made. The packaged app was built but the real WKWebView request → provider run →
artifact → revision → approval journey was not exercised; keep that as a B3/B6 gate.

## Latest handoff — 2026-09-17, roadmap A4–A7 implementation

The user authorized implementation after the 0.2 roadmap planning session.
`main` now includes A4 commit `4fdae38` (`Add workspace finder and native Browse`)
on top of the existing A2 commit `92ee4d7`. A3 durable terminal ownership remains
open and unimplemented; do not invent a commit or claim live-process persistence.
A4 remains open only for its packaged WKWebView/Finder Browse and warm-search gates.

A5–A7 are implemented and tracked as closed in `Code-6un.5`, `.6`, and `.7`, but
their source changes are uncommitted. Preserve them and the tracker update in
`.beads/interactions.jsonl`; no push was made.

- A5 adds canonical, intent-only Beads initialization/bootstrap with verified
  `bd 1.2.2` arguments, existing-store refusal, error classification, duplicate
  suppression, post-success verification/refresh, Board/Explorer actions, and a
  rebindable command. Packaged real missing-binary/permission checks remain unrun.
- A6 adds persisted workspace order, stable pointer/keyboard workspace and terminal
  tab reorder, next/previous/direct selection and reorder commands, and accessible
  announcements without replacing pane/session identities. The browser reload-ratio
  soak passed twice for all 20 cycles at pane count 2 and ratio 0.421875. Native
  fullscreen, real Neovim/IME, reduced-motion, and pointer-drag checks remain unrun.
- A7 adds versioned schema-validated semantic recipes, recording only while explicit,
  typed targets/arguments, import/export/migration, bounded undo, editor/binding UI,
  authorization, cancellation/timeouts/recursion bounds, and a Review workspace
  fixture. It never records raw terminal keys, clipboard, passwords, or provider
  output. Packaged record/edit/import/export/replay evidence remains unrun.

Evidence after integration: full Vitest `217/217`, focused A5/A6 `37/37`, focused
A5/A7 `26/26`, recipe browser `1/1`, Rust Beads tests `14/14`, TypeScript/production
build, Cargo check, and `git diff --check` passed. The first full browser run was
`73/75`; its ambiguous Settings selector was corrected and passes focused `1/1`,
while the layout soak passes focused twice. The full browser suite was not rerun
after those focused checks, so do not record `75/75`.

## Current planning handoff — 2026-09-16, after v0.1.0

Start with [the 0.1.x / 0.2.0 master plan](docs/roadmap-0.2/MASTER-PLAN.md),
then its [research](docs/roadmap-0.2/RESEARCH.md),
[Sol/Luna implementation prompts](docs/roadmap-0.2/IMPLEMENTATION-PROMPTS.md),
and [hands-on validation](docs/roadmap-0.2/ACCEPTANCE.md).
These documents supersede older release sequencing and next-task suggestions,
not the safety, tracking, or adaptive orchestration contract below.

Observed baseline: clean `main`, HEAD and local `v0.1.0` both
`f61430b5a0c74041db036ddad1bcabb953069f00`; GitHub reports v0.1.0 published
2026-09-15 as a prerelease, with DMG, checksum, and screenshots. The September
15 and earlier “uncommitted” handoffs below are historical, not current status.
Designer remains a prototype in the released README. Partial controls in source
are not proof of a complete request/run/preview/revision/approval journey.

This session is research/planning only: no app fixes, provider launches, auth,
Beads writes, new releases, commits, or pushes. Prompts are saved, not executed.
The user requests Sol-led implementation with bounded Luna ownership later.
Runtime/protocol slices explicitly use Sol; local model configuration still
owns actual model IDs and effort. No mandatory review agent or fixed pipeline.

Meta-priorities: hardware efficiency and speed; stable terminal process,
screen, scroll anchor, and focus across navigation; no hidden model turns on
restore, configuration reads, idle orchestration, or unchanged pulse results.
Pulses are optional intake, never required for manual/local orchestration.
Settings must offer simple defaults plus named harnesses, connections, command
recipes, and a schema-validated manual/prompt editing route that works from a DMG.

User-reported priorities: systemic terminal bottom clipping/cursor loss and
scroll jumps; close/quit confirmation and honest session continuity; lightweight
workspace finder with native Browse; Beads initialization; tab reorder and
ergonomic navigation even in fullscreen; named interaction recording. The five
Developer feature items are staged with the 0.1.x workstream at the user's
request. This is an explicit release-policy exception for compatible preview
additions; material/breaking workflows remain documented and versioned honestly.
The 0.2.0 target is the functional Designer plus shared orchestrator, configurable
harnesses/MCP intake, optional bounded pulses, and packaged acceptance gates.

References include `~/codex-astra-luna-orchestrator` and
`~/Desktop/Code/cmux`. Borrow patterns; inspect pinned
licenses before copying material. Future authenticated `work-auth-mcp` and
internal `work-tools` work for Jira/GitHub/Teams is explicitly recorded; their
schemas and authentication flow are unknown here and must be discovered where
Sol has those tools. Svelte assessment stays under `Code-1dh`, not a release
prerequisite or an authorized migration.

## Release versioning

- Use Semantic Versioning and Git tags formatted as `vMAJOR.MINOR.PATCH`. Keep releases in `0.x` while the app is an incomplete preview.
- During `0.x`, increment PATCH for compatible fixes and packaging/documentation corrections; increment MINOR for a new user-visible capability or a materially changed workflow. Document any breaking change explicitly even though SemVer permits it before `1.0.0`.
- Keep the version synchronized in `package.json`, `package-lock.json` when npm changes it, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` when Cargo changes it, and `src-tauri/tauri.conf.json`. Do not edit lockfiles incidentally.
- Mark preview releases as GitHub prereleases until the Developer workflow is release-tested and the Designer workflow is functional. Never call a Designer-only mock or visual prototype complete.
- A release tag must point at the exact verified commit. Before publishing, require the production frontend build, relevant unit/browser/Rust suites, a fresh Tauri bundle, a packaged-app native smoke, and `git diff --check`. Record observed evidence separately from limitations.
- Every release must include install/upgrade instructions, SHA-256 checksums, what works, what does not, a hands-on test checklist, future direction, architecture/OS support, signing/notarization status, and screenshots captured from that exact build.
- Do not move or overwrite an existing public tag or release. If a published artifact is wrong, issue a higher patch version. Rewriting unpublished branch history still requires explicit user authorization and a verified force-with-lease target.

## Latest handoff — 2026-09-15, designer readability and terminal controls

Implemented the user-reported designer and multi-terminal UX slice on `main`
at base HEAD `c80bc6b`; all changes remain uncommitted. `Code-0cp.10`,
`Code-0cp.10.1`, and `Code-0cp.10.2` track the delivered work; `Code-6io`
tracks the gate-list compatibility repair. Deferred epic `Code-1dh` records a
future evidence-based React-to-Svelte migration evaluation; no migration work
was performed.

- The rejected request-card grid redesign was fully reverted to the original
  designer layout. A deliberately narrow follow-up keeps that layout while
  allowing long bead titles to wrap safely, revealing a third line on hover,
  and wrapping long selected-request descriptions without clipping.
- Settings > Appearance now provides persisted 80–120% interface scale,
  comfortable/compact density, and reset. The implementation uses CSS
  variables and event-driven local state rather than CSS zoom, polling, or any
  PTY/provider hot-path work.
- Terminal tiling now exposes configurable directional focus at
  Cmd/Ctrl+Alt+Arrow, directional resize at Cmd/Ctrl+Alt+Shift+Arrow, and
  full-canvas toggle at Cmd/Ctrl+Shift+Enter. Resize uses bounded 5% split-tree
  steps; panes and PTYs remain mounted. Settings has a searchable Terminal pane
  controls group where all nine actions can be changed or cleared individually.
- Rust gate-list parsing now treats a valid JSON `null` response from `bd gate
  list --json` as an empty list. Valid arrays retain human-gate filtering and
  malformed non-null payloads still surface an error.

Evidence: full Vitest `175/175`, full Playwright Chromium/mock `74/74`, focused
Rust gate parsing `12/12`, production build, TypeScript, and `git diff --check`
passed. The browser suite
includes directional focus/resize, 50% -> 45% -> 50% ratio movement, pane DOM
identity, and a 20-cycle fullscreen soak. No provider call, credential access,
lockfile edit, commit, or push was made. A packaged WKWebView visual check of
the designer wrapping, empty gate state, and real PTY keyboard behavior remains
a separate native evidence gate; do not claim it from mock-browser results.

## Adaptive Orchestration Contract

- Model and reasoning assignments live in `~/.codex/config.toml` and `~/.codex/agents/*.toml`; do not duplicate or override them here.
- The primary agent owns scope, decisions, delegation, and synthesis, not routine implementation. Treat orchestration as adaptive routing, not a fixed explorer -> worker -> tester -> reviewer pipeline.
- Delegate only when separation materially helps. For small coding work, use one bounded implementation worker with complete ownership. Add specialists only when the actual risk or independent work warrants them.
- The worker owns implementation and focused validation and should finish its assignment rather than repeatedly hand routine work back. Prefer non-overlapping ownership for parallel workers.
- Use the configured Luna worker by default. Use the Sol worker only when the user asks for Sol or Luna is impractical because of usage, credits, or availability.
- The primary Sol agent and any orchestrator must not inspect, reread, diff-review, or independently review worker-authored code, and must not spawn a reviewer. Accept the worker's completion report and test evidence.
- Review worker-authored code only after the user personally reports a bug in that code and asks for diagnosis or repair. Keep verification proportional to risk without automatically creating a separate tester stage.

## Human-readable subagent prompts

- Write every subagent prompt as if you were briefing a capable human teammate who cannot see the parent conversation.
- Use plain, complete sentences. State the desired outcome, why it matters, the exact scope or files owned, relevant context and constraints, acceptance criteria, and the focused checks to run.
- Include concrete bead IDs, errors, commands, paths, and definitions the teammate needs. Do not rely on unexplained shorthand, internal labels, or implied context.
- Keep the prompt concise but self-contained, and ask the subagent to report files changed, validation run, and any remaining uncertainty.

## Start here

## Latest handoff — 2026-09-12, provider-neutral interactive chat slice

Implemented `Code-am5.3` on the existing uncommitted foundation work. The
developer chat now has a persisted Claude/Codex choice in Settings, shows
binary availability without reading credentials, labels the toolbar and chat
surface with the actual provider, and captures the provider at explicit chat
start so changing the setting cannot remount a live chat into another backend.
Claude resume/approval behavior remains Claude-only; Codex uses its own local
app-server adapter, read-only thread policy, and no resume fabrication.

The mock harness covers provider discovery and Codex start/send/kill/status
command routing. The Codex adapter is registered in Tauri and follows the
documented initialize → thread/start → turn/start JSONL boundary. No provider
was launched, no authentication or credentials were inspected, and no paid
call was made. `Code-0cp.4` remains open: its retained-terminal palette work
still needs the required packaged LazyVim native before/after check.

Evidence for this slice: Vitest `156/156`, Playwright browser-mock `70/70`,
Rust `97/97`, cargo check, production build, `rustfmt --check` for the new
Codex module, and `git diff --check` passed. Repository-wide `cargo fmt
--check` remains red on pre-existing files and was not applied broadly. No
commit, push, lockfile edit, or native provider work call was made.

## Latest handoff — 2026-10-12, v0.1.6 source round (uncommitted, unbuilt)

Epic `Code-gya`, from the Todoist task "Manually test 0.1.5 with bugs/features".
The task list, statuses and the Designer live-session design are in
`CLAUDE.md` ("v0.1.6 task list"); the draft notes and hands-on checklist are in
`docs/releases/v0.1.6.md`.

Things the next session should know that the code does not say:

- The Todoist P1 "bottom rows hidden" was a layout bug, not an xterm bug:
  a flex item holding an xterm needs `min-height: 0`, because xterm sizes its
  screen in pixels and that becomes the item's automatic minimum.
- xterm cannot measure its cell until its screen first intersects the viewport.
  A fit before that is a silent no-op, so sessions re-fit once a frame after
  attach. Any new host whose size never changes depends on this.
- On macOS, xterm swallows Control chords it can send to the shell, so they
  never reach the window key handler; Command chords pass through. The leader
  from a focused shell is therefore `Cmd+P`, and live tests must press
  `Meta+p`, not `Control+p`, once the shell has focus.
- `tests/live/pane-notifications.spec.ts` rewrites
  `docs/images/releases/v0.1.5/*.png` on every run. Restore them with
  `git checkout -- docs/images/releases/v0.1.5` before committing.
- The Playwright suite needs `npx playwright install chromium` once per
  Playwright upgrade on a machine.
- A Claude Code hook has no controlling terminal, so `/dev/tty` fails inside
  it. Pane shells export `BEADS_STATION_TTY` (the pty's device path) and hooks
  write there. Verified by starting the real CLI in a pseudo-terminal with no
  prompt; that is the only provider process started in this round.
- Claude Code 2.1 and Codex 0.162 both run in the alternate screen with mouse
  reporting on. That is why selecting needs Option-drag, and why the old
  "repeated text in scrollback" report no longer applies to them.
- Codex keeps its rollout file open; `lsof -g <pgid>` yields the session id.
  The user's `~/.codex/config.toml` already sets `notify` for another tool, so
  never write that key; app-started Codex gets `-c tui.notifications=true`.
- `serde_json` now has `preserve_order` so editing `~/.claude/settings.json`
  keeps the user's key order.
- Two older tests in `claude.rs` (`kill_all_on_empty…`,
  `completion_poll_keeps_live_child…`) share global run state and can fail
  together when they interleave; rerun before investigating.
- cmux (`~/Desktop/Code/cmux`) is GPL-3.0-or-later: take approaches, not code.
  Its live persistence is an opt-in tmux owner; its browser pane is a native
  web view placed over the pane.
- The second round (rows 13-23 of the task list) was committed and a DMG was
  built locally. Nothing was tagged, released or pushed. Todoist was read, not
  changed. No model turn was sent to any provider.

Next, in order: run the 0.1.6 checklist in the built app; publish the release
with screenshots from that build; then per-prompt snapshots ported from Napkin
Claude (`Code-n76`) and the native browser web view (`Code-vjy`).

## Latest handoff — 2026-09-12, three UI regressions resolved

User asked to pick and resolve at least three easy regressions. Implemented and
verified `Code-0cp.3`, `Code-0cp.5`, and `Code-0cp.6`; no work was started on
native LazyVim colors (`Code-0cp.4`) or provider-neutral chat (`Code-am5.3`).

- `Code-0cp.3`: the primary workspace entry now typeaheads against already
  discovered projects, mirrors its query in the lower search field, opens the
  best match on Enter, and keeps slash/tilde/dot paths on explicit
  `projects_open` semantics. Typing never rescans or opens a workspace.
- `Code-0cp.5`: fullscreen is now an authoritative command with the existing
  Cmd/Ctrl+Enter default and command-palette execution. Settings exposes its
  binding, while WhichKey and Settings share context-aware global/terminal
  leader tables. Cmd/Ctrl+P remains the leader hatch; terminal leader `p`
  remains project cycling and `e` is the files explorer mapping.
- `Code-0cp.6`: board cards dispatch the existing repo-qualified `issue:open`
  event on double-click and Enter/Space, with pointer movement beyond the DnD
  threshold excluded from activation. Issue detail ignores events for another
  active repo.

Evidence from this handoff: focused Vitest `15/15`, full Vitest `153/153`,
production `npm run build` passed, and Playwright browser-mock `69/69` passed.
A freshly rebuilt debug `.app` native smoke opened the picker, discovered 39
projects without opening them, typed `Nex` in the prominent field, showed only
Nexus plus an `Open Nexus` action, and dismissed without opening it. No commit,
push, lockfile edit, provider call, credential inspection, or Neovim config
change was made. The three beads are closed with this evidence; `Code-0cp.4`
and `Code-am5.3` remain open.

## Latest handoff — 2026-09-12, user-reported daily-driver regressions

User supplied native screenshots and asked to split the regressions into tracked
work, update this handoff and Beads, and bring back the missing behavior. Five
new child beads were created after confirming this checkout is the maintainer
database (`bd where` points to this repository). No implementation, commit,
push, lockfile change, credentials inspection, or provider work call was made
in this handoff.

Source/commit evidence first, rather than screenshot-only diagnosis:

- `Code-0cp.3` (P1 bug): the primary `WorkspacePicker` folder input is separate
  from the lower discovery `query`, so typing in the prominent field does not
  filter results. Restore typeahead without reintroducing eager opening or the
  `Code-9ff` root-rescan regression.
- `Code-0cp.4` (P1 bug): reproduce the reported all-green LazyVim native pane
  before changing code. `TerminalSession` already applies its palette on
  attach/theme changes and `pty.rs` sets `TERM=xterm-256color`; determine the
  actual palette, renderer/refresh, PTY capability, or escape-sequence cause.
  Preserve PID/input/Unicode and never alter the user’s Neovim configuration.
- `Code-0cp.5` (P1 feature): fullscreen already exists at Cmd/Ctrl+Enter
  (`94cc926`), but is poorly discoverable. Cmd/Ctrl+P intentionally arms the
  leader and its `p` mapping can open the file explorer. Settings only renders
  configurable `COMMANDS`, whereas leader chords are hard-coded in
  `useVimNav`, causing the misleading blank-key display. Unify truthful help
  and presentation without stealing editor input or silently changing leader.
- `Code-0cp.6` (P1 bug): restore board-card double-click detail/actions.
  `IssueTree` still emits `issue:open` and `IssueDetail` still listens, but
  `Board` renders draggable `Card`s with no activation handler. Keep drag
  distinct from activation and retain accessible equivalent behavior.
- `Code-am5.3` (P1 feature): replace toolbar-only “Start Claude chat” with a
  settings-backed, provider-neutral interactive-chat choice limited to
  supported Claude/Codex adapters. Designer ticket runs already select either;
  the interactive `ClaudeChat` route is Claude-specific. No arbitrary-provider
  claim, automatic launch, credential access or paid smoke is authorized.

Current HEAD is `70294da` on `feat/daily-driver-foundation`; the checkout was
clean before this documentation edit. `Code-0cp.1` is closed in Beads with the
post-repaint native visual check recorded in its notes, despite the older
historical paragraph below. `Code-0cp.2` remains the sequential narrow
accessibility task. Start any implementation with the smallest non-overlapping
bead and record focused plus native evidence as applicable. Recommended
ownership: Luna for `.3` or `.6`, Sol Medium for `.4`, `.5`, or `.3`; use
Astra only if the color diagnosis or provider contract conflicts with current
runtime ownership.

## Latest handoff — 2026-09-11, cancellation repair and model handoff

User requested cancellation repair, practical prompts saved but not run, and then
asked to close out verified tasks and leave Sol/Luna work for later comparison.
**Do not expand into conductor or artifacts automatically on resume.** Preserve
all uncommitted changes on `feat/daily-driver-foundation` (base HEAD `2a13f69`).
No commit/push, lockfile edit, credentials inspection or native provider work call.

Read `docs/FOUNDATION-VERIFICATION.md` section "Cancellation repair and practical
handoff" and `docs/PRACTICAL-TEST-WORKFLOW.md`. Root repaired Rust; one bounded
Sol High worker fixed frontend reconciliation and completed its assignment.

- Code-am5.1 **closed**: repaired kill-before-drain; child remains reachable through
  nonblocking completion polling; consistent RUNS -> TERMINALS locks retain
  admission/permit through reap and terminal snapshot transfer. Five-second
  cancellation timeout preserves unknown ownership; no final seq before drain.
  Fake shell tests cover exact PID, pipe-open cancellation, early pipe closure,
  already-exited success, snapshot visibility and timeout/reconcile. Frontend
  fixes status watermark, new-attempt races, backend active-owner recovery,
  missed cancel events, and stale error responses. App/backend quit remains a
  restart boundary; no claim of durable external runtime or real provider auth.
- Code-0cp.1 remains in_progress: mock pane/theme checks pass, but native split
  and unsplit showed blank terminal rendering despite shells surviving. Next Sol
  task: reproduce and repair repaint/reattachment, preserving session/PID and
  input ownership. Inspect terminalSessions.ts, Terminal.tsx, TerminalPanes.tsx.
  Do not infer cause from screenshot alone; distinguish CUA focus/paint delay.
- Code-0cp.2 is the next **Luna Low** task: terminal tab accessible names, roles
  and selected state only; no key handler/session/layout edits. Do sequentially
  with Sol because both may touch TerminalPanes.tsx.
- Code-am5.2 remains open for **Sol Medium/High after native pane repair**:
  local artifact capture, preview, exact run+revision approval. No provider/game
  calls required; use local fixtures. Root/Astra reviews approval semantics.
- Native evidence: rebuilt bundle launched via CUA; explicit disposable folder
  `/tmp/beads-station-native-smoke-20260911` opened; discovery found 38 projects
  without auto-opening all. Unicode paste printed `native-smoke pid=80803 café
  日本語`. Split/unsplit produced two tabs and shell PIDs 80803/81561 survived,
  but screen subsequently blank. Finder attachment failed `cgWindowNotFound`;
  intermittent CUA `noWindowsAvailable` recovered on reattach. No Finder release
  gate, soak or Neovim gate claimed. Do not kill unrelated user dev sessions.
- Latest verified counts and bundle timing are in FOUNDATION-VERIFICATION.md;
  prior stop's unfinished-patch warnings below are historical, superseded here.

Use **Sol directly** for the next bounded implementation rather than keeping
Astra supervising routine work. Use Luna for the narrow accessibility task.
Return to Astra for conflicting evidence, ownership/approval architecture or
final risky review. No measured per-model quota ledger exists: record actual
user-visible before/after quota and effective model/effort, otherwise unknown.
See `docs/AGENT-MODEL-ROLES.md` for official sources and copy/paste prompts.
The memory game/read-only/revision/cancel workflows are saved and **not run**.
Smoke workspace was closed and only the app instance launched for this test was
quit at cleanup; final rebuilt bundle is ready for the next manual run.

### Previous handoff — 2026-09-11, usage-limit stop

User explicitly stopped: "usage finished, close quickly and log agents.md to resume".
**Stop expansion. Fix the unfinished Code-am5.1 patch first on resume.**
Branch `feat/daily-driver-foundation`, HEAD `2a13f69`; checkout was clean at this
session start. All this session's work is uncommitted. No commit/push, lockfile
change, credentials inspection, or native provider CLI work calls.

Read `docs/FOUNDATION-VERIFICATION.md` section "Pane/themes and interrupted native
reload — 2026-09-11" first. Preserve current changes.

- **Code-0cp.1 (root, implemented; final integrated gates pending):** visible
  Split right/down, Close pane, Zoom/restore, and **Unsplit to tabs** (keeps all
  sessions); palette commands for close/unsplit/zoom. Fixed stale zoom and duplicate
  pane kill requests. Separate persisted Developer/Designer themes with legacy
  migration and per-view reset. Settings search, Terminal category, cursor
  shape/blink, bounded scrollback, terminal defaults. Appearance updates detached
  terminal sessions through session-owned subscriptions. Designer topbar now has
  Commands/Settings (Sol integration). Local cmux `803dc2657f` inspected for search,
  reset and pane interaction patterns; no source/assets copied.
- **Code-am5.1 (Sol WIP, NOT accepted; root takeover pending):** snapshots,
  workspace/ticket/attempt identity, seq merge, bounded terminal snapshots,
  reconnect/check-status and unknown-state cancel exist. **Latest Rust patch is
  unfinished and untested. Do not launch provider work or claim cancellation is
  correct.** `cancel_native_run_process` currently waits on `drained.notified()`
  BEFORE killing the child: this can deadlock. Fake helper never notifies, so its
  cancellation test can hang. Completion takes the child and awaits exit, making
  cancellation unavailable if the process closes pipes before exiting. Snapshot
  clones terminal history before locking active runs, so the claimed atomic
  transition still has a gap. Root's planned correction was NOT applied.
- Next correction: consistent registry locking (prefer RUNS -> TERMINALS), hold
  admission reservation through reap and atomic terminal snapshot retention;
  cancel must kill/reap before waiting for pipe drain with bounded error handling.
  Keep child reachable for cancellation during ordinary completion wait (e.g.
  nonblocking try_wait under registry lock with polling outside lock). Preserve
  unknown ownership on failures. No synthetic terminal seq before output drains.
  Review FE snapshot status vs historical running events, stale snapshot/new
  attempt races, and reconcile after cancel when event delivery fails. Add focused
  race tests against production helpers, then integrated gates. Sol stopped and
  reported no running commands; do not assume its earlier pass covers final patch.
- **Native gate Code-9ff/Code-oan still open:** CUA native service failed twice
  (`Sky Computer Use native pipe startup failed`); no app launch/typing verified.
  Do not kill the user's dev process. Last bundle is from the prior session.
- Evidence timing: root full unit **137/137** and full Chromium/mock **65/65**
  passed at intermediate state. Later theme migration/pane/session focused
  **33/33**, then detached appearance **6/6** passed. Early production build
  passed. Sol reported FE reconciliation **3/3**, Claude Rust **7/7**, earlier
  full Rust **90/90**, and tsc before its final unfinished patch. **No final
  integrated build/cargo/native bundle gate after last edits.**

Keep Code-am5.1 and Code-0cp.1 in_progress until reviewed and final checks pass.
Do not start Code-am5.2 artifacts, conductor, or broader customization yet.
Root owns final corrections/review; no workers remain active.

**Latest handoff — 2026-09-10, settings/UI session:** User stopped expansion as
the five-hour usage limit approached. Finish from this table; do not restart
planning. Root handled settings/commands/appearance/native investigation; one
bounded Sol assignment handled Claude resume. Current branch is
`feat/daily-driver-foundation`, HEAD `1699ac3`. The checkout was clean at this
session's start; the changes listed below are now uncommitted. No commit/push.
`package-lock.json` was not changed in this session. Older statements below about
HEAD `7a027c6` and an outstanding lockfile edit are historical.

Read `docs/FOUNDATION-VERIFICATION.md` section "Settings and appearance handoff"
first. Current evidence: production build and bundled debug `.app` build pass;
132/132 frontend unit tests, 63/63 Chromium/mock tests, 88/88 Rust tests pass;
cargo check passed before the final `projects_open` change, which subsequently
passed cargo test and native bundle compilation. No paid provider calls.

| Order / state | Bead | Work and next acceptance gate | Owner / scope |
| --- | --- | --- | --- |
| Delivered | `Code-4zm` | Dedicated General/Appearance/Keyboard shortcuts/Sessions settings; uniform toolbar; macOS Settings menu; persisted command bindings and right-aligned palette hints; removed misleading Obsidian placeholder writer; theme surface/contrast repair; theme previews and terminal font/size/line-height. Native settings menu, Fahrenheit and One Light visually checked. | Root implemented. Shared registry covers current palette commands, **not all bd verbs or pane sequences**. |
| Delivered | `Code-b57` | Resume only after explicit chat intent and a saved provider-observed ID; Cancel/Escape/backdrop do not launch; New session clears resume ID; persisted ask-before-resume toggle. | Sol implemented; root integrated and verified. Actual provider transcript existence/auth remains untested. |
| **Next: verify** | `Code-9ff`, `Code-oan` | Packaged smoke found both discovery and explicit open blocked in `read_dir -> __open_nocancel`; eventually recovered. Fixed direct open to avoid rescanning unrelated roots and run filesystem work on blocking executor. **Latest rebuilt bundle has not been relaunched after this fix.** Verify direct open and shell typing; diagnose discovery delays separately. | Root. Sample: `/tmp/beads-settings-native-sample.txt`. Do not claim a completed Finder/release gate. |
| Next lifecycle slice | `Code-am5.1` under `Code-am5` | Backend native-run snapshot/reconciliation; reload reconnects output and cancel to actual child, no duplicate launch, unknown stays unknown. | Bounded Sol brief already in bd; root owns contract/review. Files `designer/nativeRuns.ts`, Rust `claude.rs`. |
| After `.1` | `Code-am5.2` under `Code-am5` | Artifact capture/preview and approval bound to exact run+revision; request changes invalidates stale approval. Dependency on `.1` is recorded. | One bounded Sol assignment after root reviews lifecycle; local fixture artifacts first. |
| Native gates | `Code-33c`, `Code-t3j`, `Code-efg`, `Code-44k`, `Code-r7q` | Real terminal PID/Unicode/paste/Neovim, details, mode/resize navigation and soak; native provider auth only on explicit intent. Full frontend suites now pass. | Root verifies. Existing historical tickets remain open; mock tests are not native evidence. |
| Conductor | `Code-yfb` | Durable workspace+ticket+attempt leases, attempt-owned merge slot, restart/unknown reconciliation, bounded budgets and effective provider/model/effort routing. | Root-led; Sol only one reviewed slice at a time. `Code-4bx` stays closed for its bounded fixes. |
| Customization | `Code-0cp` | Remaining bd command forms/coverage, rebindable pane sequences, per-workspace preference overrides, designer resizers, optional integrations with useful explicit actions. | Root chooses concrete groups; Sol implements bounded groups. Cmd/Ctrl+P and Neovim Escape stay protected. |
| Later, existing roadmap | M2 / M6 / M7 | Pin/evaluate Herdr before PTY migration; external issue/PR sync only after local artifact review; signed release and measured performance remain outstanding. | No new runtime owner, external posts, or broad migration without its own verified slice. |

Settings source: `src/components/SettingsPanel.tsx`, `SettingsPanel.css`,
`src/state/commands.ts`, `settings.ts`, `sessionPreferences.ts`,
`terminalAppearance.ts`; native menu in `src-tauri/src/lib.rs`.
The native menu currently has a clickable Settings item without a fixed native
accelerator; Cmd/Ctrl+, is dispatched through the configurable frontend registry.
The local cmux checkout is **`~/Desktop/Code/cmux`**, not `~/Code/cmux`.
Inspected its settings sidebar/shortcut recorder and license; borrowed interaction
patterns, copied no code/assets. Preserve real xterm/Neovim ownership.

Latest debug bundle:
`src-tauri/target/debug/bundle/macos/Beads Station.app`.
The inspected smoke bundle was quit; a separate `target/debug/beads-station`
development process was still running at handoff. Do not kill user dev sessions.

### Previous handoff — historical context

User previously stopped expansion with 8% usage remaining.
Read `docs/FOUNDATION-VERIFICATION.md` section "Native/designer and UX slice"
before continuing. Current work is uncommitted; preserve all existing changes.
Native designer runs and conductor hardening are implemented as a bounded slice,
not completed M2/M4/M5. Prioritize the pending gates below; do not restart planning.

### Next session, in order

1. Finish verification of new `designer/nativeRuns.ts`: navigation retains runs;
   reload reports unknown; add backend snapshot/reconciliation so reload can
   reconnect and cancel the actual child. Test both native providers with explicit
   user intent and existing CLI login; never inspect credentials.
2. Complete designer artifact/preview capture and revision-bound approval. Request
   creation, ticket context, explicit start/cancel/output/revision prompts exist;
   approval is deliberately unavailable until an artifact revision is captured.
3. Run native WKWebView/Finder smoke for workspace typing, bead details, theme,
   resizes and mode switches. Finish frontend full-suite verification; distinguish
   macOS dependency-read timeouts from assertion failures.
4. Conductor: durable workspace+ticket+attempt leases/reconciliation, bounded
   budgets/routing/effort and verification. Current registry is memory-only,
   merge holder is still `builder:{bead_id}`, and remote unknown needs operator
   reconciliation. Herdr CLI is absent: pin/evaluate before any PTY migration.
5. Remaining customization: rebindable command registry covering all bd verbs,
   font/line-height controls, designer column/chat resizers, per-workspace view
   preferences and native visual polish. Existing palette is Cmd/Ctrl+K;
   Cmd/Ctrl+P remains pane leader. Do not intercept Neovim Escape.

Tracking: `Code-am5` native/designer remains open; `Code-t3j` UX needs native
verification; `Code-fx2` covers bead/input fixes; `Code-4bx` bounded conductor
correctness is closed with explicit Herdr limitations. Use Luna for small UI
fixes, Terra for lifecycle review, Sol only for one bounded implementation;
avoid parallel model proliferation and paid provider smoke calls by default.

Read this file, then `docs/ASTRA-DAILY-DRIVER-PLAN.md`. Consult `CLAUDE.md` for bd workflow and `BEADS-CONTEXT.md` for historical implementation details; their machine paths, phase status, and some completion claims are stale. Current source and reproduced behavior outrank historical comments.

The user authorized implementation after the planning review. Current branch: `feat/daily-driver-foundation`, based on `7a027c6`. The workspace/terminal foundation is implemented; see the implementation record in `docs/FOUNDATION-VERIFICATION.md` for checks and remaining native gates. No commit or push has been made.

## Product intent and decisions

Build a lightweight Tauri daily driver that can replace the user's CMUX + Neovim/LazyVim workflow. Preserve Beads Station's identity: tickets, dependencies, visible agent work, review gates, and an intelligent conductor. Developers need a terminal-first workspace; designers need an outcome-first request/preview/review experience over the same runs.

- Discovery is not opening: directory scans populate a picker, never every workspace tab. Restore only explicitly opened workspaces; first launch offers recent/open folder.
- Use `~/Desktop/Code` as the suggested root on this Mac, with persisted configurable roots and graceful missing-root recovery. Never replace one person's hardcode with another's.
- Native local Claude/Codex terminal login is the default here. Gateway belongs to the other laptop and must be an optional explicit profile, never a prerequisite. Do not inspect, print, copy, or commit credentials.
- Keep the terminal fully useful with providers/conductor disabled. Launch agents on intent, not component mount or project discovery.
- Preserve real Neovim/LazyVim and the user's configuration. App commands must not steal editor/terminal keystrokes. Do not recreate the editor in React or overwrite `~/.config/nvim`.
- Retain existing split/layout/theme work. Make workspace, pane, provider session, and ticket run identities explicit. A saved layout is not a surviving process.
- Prefer deterministic scheduling, leases, dependency checks, tool execution, caching, and verification. Use a small model only for ambiguous estimation; escalate work with evidence and bounded retries. Future local Qwen is an adapter target, not a demo prerequisite.
- Show actual provider/model/effort and actual run outcomes. Unknown usage stays unknown; cancel is not completion. Approval applies to a concrete run/artifact revision.
- Herdr is a promising runtime adapter, not yet a verified drop-in backend. Prove attach/output/input/resize/cancel/recovery against a pinned version before migrating ordinary terminals. Keep jcode optional. Never add two competing PTY/scheduler owners.
- Designers must be able to complete a ticket without being forced into a terminal. A graph is a secondary dependency view, not the default creation/review flow.

## Checkout and machine facts (2026-09-09; implementation update)

- Repo: `~/Desktop/Code/Beads-Station`; derive paths from the working tree in scripts.
- Implementation branch: `feat/daily-driver-foundation`, HEAD `7a027c6` (uncommitted work). Base branch: `exp/just-works-backbone`. `origin/r12-live-verify` is `e959d17`, an ancestor eight commits behind. `git ls-remote` confirmed both remote heads on this date. No merge/cherry-pick is currently needed; recheck if remote moves.
- Existing user change: `package-lock.json` (54 deleted lines at review start). Preserve it; do not reset, regenerate, or include it incidentally.
- `codex`, `claude`, `nvim`, and user-installed `bd` are available. Provider authentication has not been exercised; herdr/jcode remain future evaluation targets.
- Repository `beads.role=maintainer`; `bd where` resolves to this checkout. The stale additional-repository path was removed. bd automatically recovered 140 historical issues from its export on first write. Implementation tickets: `Code-vnb` and `Code-ecs`.

## Tracking and workflow

Use bd for implementation tracking once it is available. Before any bd write, work from this repo, verify `beads.role=maintainer` and `bd where`, and repair the stale federation deliberately. Read `.beads/issues.jsonl` only as a passive historical export; never edit it or the Dolt files directly. Read back writes to verify persistence. Use the existing recovered local database; do not initialize another one.

The user expressly requested a markdown plan, so the plan is authorized despite CLAUDE.md's older ban on markdown TODO lists. Milestone labels in it are planning references, not fabricated bd IDs. Reconcile existing tickets before creating implementation issues. Historical IDs may live in the missing planning repository.

CLAUDE.md's `~/...` cwd, Obsidian mirror, daily writer, and mandatory push recipe describe the old machine. Do not create those directories or push merely to complete this documentation handoff. Keep current work self-contained here; follow the user's current scope for publishing and commits.

## Source map and highest-risk gaps

| Area | Read | Preserve / investigate |
| --- | --- | --- |
| Discovery | `src-tauri/src/projects.rs`, `src/state/projects.ts`, `src/components/TabBar.tsx` | Configurable roots, canonical IDs, separate discovery/open state; now implemented |
| Terminal | `src-tauri/src/pty.rs`, `src/components/Terminal.tsx`, `src/components/TerminalPanes.tsx`, `src/state/termPanes.ts` | UI-lifetime sessions and Unicode decoding implemented; durable external attach and backpressure remain |
| Process budget | `src-tauri/src/spawngov.rs`, `claude.rs`, `bd.rs` | Separate utility, agent and PTY budgets implemented |
| Agent lifecycle | `src/components/ClaudeChat.tsx`, `src-tauri/src/claude.rs`, `envloader.rs`, `binresolve.rs` | Explicit start and native auth default implemented; provider-neutral run identity remains |
| Conductor | `src-tauri/src/conductor.rs`, `herdr_bridge.rs` | Fixed model strings; no effort dispatch; herdr names collide per repo; cancel reports completion; transport lacks deadline |
| Designer | `src/components/designer/DesignerShell.tsx`, `BeadGraph.tsx`, `GateCockpit.tsx`, `SensorsPanel.tsx` | Selected issue discarded when opening agent; no end-to-end request/preview/sync flow |
| Themes and updates | `src/lib/themeImport.ts`, `src/state/palette.ts`, `src/lib/bdCache.ts`, `BdLiveProvider.tsx` | Theme import and snapshot/listener dedup already exist |

## Verification and efficient sessions

For model responsibilities and escalation rules, read
`docs/AGENT-MODEL-ROLES.md`. Astra owns product direction and orchestration;
workers operate within the bounded assignments defined there.

Do the smallest complete milestone, then record concrete evidence and next steps. Avoid rereading all 890 lines of BEADS-CONTEXT.md or adding more architecture before the app boots and terminals survive navigation.

For implementation, run relevant regression tests and existing gates: `npm run build`, `npm test`, `npm run test:live`, `cargo check --manifest-path src-tauri/Cargo.toml --quiet`; run `cargo test --manifest-path src-tauri/Cargo.toml` for Rust behavior changes. See `docs/FOUNDATION-VERIFICATION.md` for current results; earlier planning-only claims below are historical.

`test:live` uses Chromium + mock IPC. It does **not** verify Tauri/WKWebView, actual PTYs, native auth, process memory, or herdr persistence. Require a packaged Finder-launched smoke and real lifecycle/performance evidence before claiming daily-driver readiness. Record observed results separately from target budgets and upstream marketing claims.

## Viewing Live Subagents

- After spawning the first subagent, tell the user once that live inspection is available inside the current Codex chat with `/agent` (alias `/agents`). Do not require status prompts to the orchestrator.
- In the ongoing parent chat, enter `/agent`, highlight a child, and press Enter to open that child's live transcript and tool activity. Use the picker again and select `Main` to return to the parent. Follow the picker's displayed key hints for navigation; supported Codex versions also show shortcuts for cycling between threads.
- The in-chat picker is scoped to the current root conversation. It shows only descendants spawned by that parent, not agents belonging to another task or an older chat.
- If an expected child is absent, first confirm that the correct parent conversation is open. Use `codex agents` in another terminal for the cross-session overview, then resume the relevant parent with `codex resume <parent-thread-id>` and open `/agent` again.
- A selected Multi-Agent V2 child may be read-only. Inspect it directly, but send corrections or follow-up work through the parent orchestrator.
