# Beads Station — agent handoff

## Start here

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
