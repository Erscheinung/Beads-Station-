# Workspace and terminal foundation — 2026-09-09

## Cancellation repair and practical handoff — 2026-09-11

Resumed from the unfinished patch on `feat/daily-driver-foundation`, base HEAD
`2a13f69`; retained all incoming edits. User then requested finishing this slice
and leaving Sol/Luna assignments for later usage comparison. No commit/push,
package-lock change, credentials inspection or native provider work request.

Code-am5.1 is closed for its bounded renderer/backend reconciliation acceptance.
Root owns Rust correction: cancellation requests kill before waiting for output;
completion uses try_wait under the run registry lock and keeps the child reachable.
RUNS -> TERMINALS is the shared lock order, with reservation/permit retained until
reap, drain and atomic terminal transfer. Cancellation has a five-second bound;
unconfirmed ownership stays registered as unknown, with no synthetic terminal seq.
Already-exited success retains needs_review instead of being relabelled cancelled.
Read errors no longer silently count as successful EOF. Snapshot history retains
50 terminal records, with 200 events per run (event count, not a total byte bound).
This still owns the direct child, not a durable external process-group runtime.

One Sol High worker owned only nativeRuns.ts/test.ts. Root review required a second
bounded correction. Final frontend changes: authoritative snapshot status over
historical events, newer live seq precedence, generation guards for stale checks,
recovery to actual backend active ownership after reload/rejected launch, and a
fresh snapshot after cancel even when events are missed or another check was
already pending. Nine focused frontend tests pass. No worker remains assigned to
ongoing implementation.

Final gates on the resulting code:

| Check | Result |
| --- | --- |
| npm test | 26 files, 146/146 pass |
| npm run test:live | 65/65 Chromium/mock pass |
| cargo test --manifest-path src-tauri/Cargo.toml | 94/94 pass |
| Claude-module focused race checks | 11/11 pass |
| cargo check --manifest-path src-tauri/Cargo.toml --quiet | pass |
| npm run build | pass; existing large chunk/import warnings remain |
| npm run tauri -- build --debug --bundles app | pass after final frontend correction |
| git diff --check | pass; package-lock unchanged |

Full Rust initially failed because parallel fixtures consumed the process-global
agent budget; fixture permits are now isolated while production spawngov tests
still exercise capacity. The default parallel cargo suite then passed. This was
test interference, not evidence to raise production capacity. Logs are under
`/tmp/beads-resume-{unit-final,live-final,cargo-final,check-final,bundle-final}.log`;
these temporary paths are convenience evidence, not durable repository artifacts.

Native evidence is separate. CUA launched the bundled app (PID 79935); Finder
attachment returned cgWindowNotFound, so this is not a Finder/release gate.
Discovery showed 38 projects without opening all as tabs. Direct open of
`/tmp/beads-station-native-smoke-20260911` succeeded with no beads DB or git repo.
Paste + Enter visibly printed `native-smoke pid=80803 café 日本語`. Automated
`typeText` lost non-ASCII in its earlier command; paste produced correct Unicode.
Split right and Unsplit to tabs produced two tabs; process inspection confirmed
shell PIDs 80803 and 81561 still parented to the app. **However terminal contents
subsequently appeared blank. Native visual/input continuity is not accepted.**
Intermittent CUA noWindowsAvailable recovered by getApp; the next reproduction
must distinguish automation focus/paint timing from terminal repaint defects.
No real provider auth, game prompt, Neovim check or native soak was performed.
The final bundle includes the last FE correction but has not been relaunched;
the observed native pane test used the preceding build with the same pane code.
Cleanup closed the disposable workspace and quit only the smoke app we launched;
no user dev session was killed.

Code-0cp.1 stays in_progress, next owned by Sol for the native blank-render
reproduction/repair. Code-0cp.2 is open for Luna to add tab names/roles/selected
state; do sequentially because both can touch TerminalPanes.tsx. Code-am5.2
artifact/revision approval stays open after the native pane repair; conductor
and broader customization remain deferred. Code-9ff/Code-oan and native parent
gates remain open rather than inferring complete readiness from direct opening.

Saved user workflow: `docs/PRACTICAL-TEST-WORKFLOW.md` contains commands, no-provider
terminal/settings checks, read-only and memory-game prompts, revision/cancel
steps, and an evidence sheet. Prompts are **not run**. `docs/AGENT-MODEL-ROLES.md`
records usage-aware defaults and official sources; no actual per-model quota
ledger is available, so no percentage savings is claimed.


## Pane/themes and interrupted native reload — 2026-09-11

User requested continuation from handoff, CMUX-inspired improvements, visible
unsplitting, separate Designer/Developer themes, and richer settings; then stopped
for exhausted usage. Started clean at `2a13f69`, branch
`feat/daily-driver-foundation`. Current work is uncommitted; package-lock unchanged.

Root implemented Code-0cp.1: pane toolbar close/zoom/unsplit-to-tabs, preserving
surviving session identity; configurable matching palette commands; duplicate
pane-kill cleanup and zoom fixes; per-view persisted themes/legacy migration/reset;
settings search and terminal cursor/blink/scrollback/default controls. Terminal
appearance subscriptions now belong to live sessions, including detached tabs.
Chromium screenshot `test-results/settings-terminal.png` was visually checked.
Local cmux at `803dc2657f`: inspected LICENSE, SettingsNavigation.swift,
PaneChromeSettings.swift and Workspace.swift; interaction patterns only, no copying.

Sol worked on Code-am5.1 (nativeRuns.ts, DesignerShell.tsx, claude.rs, lib.rs,
mockIpc.ts and tests). Backend snapshots/identities, ordered buffered events and
retained terminal snapshots exist; frontend uses discovery/subscribe/second
snapshot, explicit status check/cancel, and unknown start ambiguity. Designer
Commands/Settings buttons added. **This slice is NOT accepted or verified final.**

Critical interrupted WIP in `src-tauri/src/claude.rs`: final Sol patch added
`drained: Arc<Notify>` and waits on its notification before requesting kill, which
can deadlock; fake helper does not notify, so cancellation test can hang. Completion
takes the child before wait, removing cancel access if pipes close early. Snapshot
history/active reads are not atomic despite comments. Root stopped Sol and was
about to correct consistent locking/admission ownership/kill-before-drain with
bounded errors and cancellation-accessible completion polling; NO such root fix
was applied before the user's stop. Also review FE status watermark ordering,
stale snapshots across attempts, and cancellation reconciliation after missed
events. Preserve unknown, never auto-relaunch. Run focused production-helper race
tests after repair, then final gates before Code-am5.2.

Checks are time-qualified: early root production build passed; intermediate full
frontend 137/137 and Chromium/mock 65/65 passed. Later root focused theme migration,
panes and sessions 33/33; final detached-session appearance test file 6/6. Sol
reported nativeRuns 3/3, Claude-focused Rust 7/7, earlier Rust full 90/90 and tsc
before the last unfinished patch. No final integrated build/cargo test/check or
new debug bundle. Existing build chunk/import and Board act warnings persist.

Native smoke attempted first per handoff: CUA service failed twice with
`Sky Computer Use native pipe startup failed`. No native app interaction or shell
typing proof, provider authentication or paid native provider calls. Code-9ff and
Code-oan remain open; prior debug bundle is unchanged. No user dev process killed.
Code-am5.1 and Code-0cp.1 stay in_progress. All workers stopped; no commands reported
running at handoff. No commit or push.


## Settings and appearance handoff — 2026-09-10

User requested screenshot-driven UI fixes and bounded plans for Sol, then asked
to stop expansion near the five-hour usage limit. Session began with a clean
checkout at `1699ac3` on `feat/daily-driver-foundation`. Current changes are
uncommitted; no push/commit and no package-lock edit in this session.

Delivered (`Code-4zm`, root): dedicated settings dialog with General, Appearance,
Keyboard shortcuts and Sessions; matching toolbar button sizing; macOS app-menu
Settings entry; shared palette command registry with editable persistent shortcuts,
conflict checks, clear/reset, and right-aligned hints. Unassigned actions show a
dash. Existing pane leader sequences remain separate and are not yet rebindable.
Removed "Open Obsidian update": it previously appended an empty Manual note,
rather than opening a note. It should return only with a useful configured flow.

Theme application now derives elevated surfaces, borders and readable muted text
from the selected palette instead of retaining Tokyo Night surfaces and taking
low-contrast text from arbitrary ANSI slots. Terminal ANSI colors remain intact.
Light/dark palettes apply to document-level portals and designer surfaces too.
Settings includes theme preview cards and persisted font/size/line-height changes
that update existing terminal sessions without recreating shells.

Delivered (`Code-b57`, bounded Sol implementation reviewed/integrated by root):
resume prompt requires explicit chat start and a saved provider-observed ID;
project allocation UUIDs are no longer sent as conversation IDs. New session
clears the saved ID; Cancel/Escape/backdrop abort start. Ask-before-resuming is
configurable. Saved IDs do not prove the provider still has the transcript.

Checks: production build passes; full frontend unit suite **132/132**; full
Chromium/mock IPC suite **63/63**; Rust **88/88**. Cargo check passed before the
final direct-open repair; cargo tests and bundled native compilation passed after
it. Emoji audit and diff whitespace checks pass. Existing Vite chunk/static vs
dynamic import warnings and Board test act warnings remain. This session's full
unit suite completed; earlier macOS dependency-read stalls did not recur there.

Native evidence: launched the bundled debug `.app` through the native app surface,
verified macOS menu -> Settings, category navigation, and visually inspected Tokyo
Night, Fahrenheit and One Light in WKWebView. Folder field accepted real typing.
Discovery and opening initially stalled; process sample showed both commands in
`scan_projects -> discover -> read_dir -> __open_nocancel`. They eventually
recovered and showed the real repo, issues and terminal. This is not a measured
startup benchmark or a completed signed release/Finder/soak gate.

Follow-up repair (`Code-9ff`, still awaiting native recheck): direct folder opening
now avoids unrelated-root scanning and runs its filesystem work on the blocking
executor. Canonical/path session records remain; ambiguous basename records are
preserved but not guessed. Rebuilt debug bundle successfully after the repair;
**did not relaunch that final bundle before the usage-limit handoff**. Discovery
itself can still stall on filesystem reads. Sample retained at
`/tmp/beads-settings-native-sample.txt`.

No credentials inspected, authentication exercised or paid provider calls made.
No Herdr migration, durable designer reconciliation or artifact approval claimed.
Ordered follow-up briefs are recorded and read back in bd: `Code-am5.1` (native
reload), `Code-am5.2` (artifact/revision approval, depends on `.1`), `Code-yfb`
(durable conductor), `Code-0cp` (remaining customization). See the current table
at the top of AGENTS.md; older milestone/handoff statements below are historical.

## Native/designer and UX slice — 2026-09-10

User requested implementation, then asked to finish quickly and slate remaining
work with 8% usage left. No commit or push. Original package-lock change preserved.

Delivered in this slice:

- Fixed current `bd show` array/object compatibility and expanded dependency
  objects. Native issue inspector shows notes, acceptance criteria, dependency
  links and claim/status/close/note/label commands (Cmd/Ctrl+Enter in the form).
- Fixed workspace input interception under logical terminal focus; modal and
  editable input owns its keys. Escape remains available to Neovim. Explorer
  discovery expansion is StrictMode-safe and includes parent beads.
- Terminal-first developer canvas, optional terminal/explorer/board/both views,
  visible Designer switch, palette in both modes, Fahrenheit theme, existing
  split resizers retained, terminal resize handle corrected and per-project
  height persistence guarded. View/collapse/focus preferences persist globally.
- Designer defaults to Requests; local request creation, native Claude/Codex
  availability and explicit ticket-bound start/cancel/output/revision requests.
  Native CLI login is used; actual model/usage remain unknown when not reported.
  Module-level nativeRuns store retains UI navigation state and persists summaries;
  reload maps active summaries to unknown, with no automatic duplicate launch.
- Conductor uses unique attempt IDs, duplicate admission protection, bounded
  Herdr RPC deadlines and explicit unknown/cancelled outcomes. Local kill/reap
  precedes merge cleanup. Only Herdr Done means completed. Unknown remote attempts
  remain registered to prevent automatic duplicate work.

Evidence: production build passed (large-chunk warning remains); full Rust suite
88/88 passed; conductor focused 23/23 and Herdr protocol tests 11/11 passed;
cargo check and diff whitespace checks passed. Workspace browser tests 5/5 passed,
including actual keystroke typing after terminal focus. Initial full mock-browser
run: 57/59 passed; two tests still asserted the old palette label and forced
designer-to-terminal spawn behavior, and were updated to the intended new behavior.
Frontend full unit run did not complete: dependency reads intermittently hang or
return ETIMEDOUT on this macOS/Node environment. One new test had a React cleanup
fixture error (moved DOM child); fixture corrected. No full unit pass is claimed.

Boundaries: no provider authentication or paid work call, native release/Finder
smoke, performance soak or visual sign-off was performed in this slice. Herdr CLI
is absent; bridge is partial, not the shell runtime. App close still reaps local
processes. Designer preview/artifact capture and revision-bound Approve are NOT
implemented; UI states that review approval is unavailable. Full reload cannot
yet reconnect to a live native run. Conductor leases are not durable and merge
holder remains bead-based. Full customizable keybinding coverage and every-panel
resizing are follow-up work, not claimed complete. See AGENTS.md for ordered next
steps. Work delegated once each to Sol (provider/designer), Terra (conductor),
Luna (final UX); root reviewed and corrected lifecycle/integration issues.

Fahrenheit colors follow the upstream Ghostty-format palette:
https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/ghostty/Fahrenheit

Final focused follow-up: palette tests 5/5, designer bead activation 2/2 and
keyboard unit tests 6/6 passed. Designer availability now tolerates malformed/null
responses; unknown restored runs cannot start duplicate work. The complete browser
suite was not repeated after these focused fixes. Full unit suite remains incomplete.

---

Branch: `feat/daily-driver-foundation`, based on `7a027c6`. Changes are uncommitted. This is the first implementation slice of M0/M1, following the user's authorization to begin work on a new branch.

## Delivered behavior

- Project discovery populates a picker; it does not open every repository. Roots are configurable, with an existing `~/Desktop/Code` preferred on this Mac. Explicitly opened folders are remembered; canonical-path UUIDs distinguish same-name repositories and remain safe in event channels.
- Developer and designer modes share a usable empty workspace picker. A folder can be opened by typing/pasting its path. Tabs have open/close controls; missing discovery roots remain recoverable.
- Claude chat starts on request. Native CLI authentication is the default; gateway environment loading and spending access require `BS_AUTH_PROFILE=gateway`. Optional notes/sensors use a portable configurable vault root.
- A terminal session owns its xterm screen, subscriptions and native process independently of React mounts. Navigation detaches the view; explicit pane/workspace closure disposes it. Output listeners attach before spawn, UTF-8 decoding retains partial characters, and pending-spawn closure kills the eventual process.
- Utility processes, persistent agents, and terminals have separate capacity pools. Saturated agents do not consume the utility permits needed for bd/git reads.

## Verification

- Full Chromium + mock IPC suite: **58 passed**, including workspace opening/restore, pane isolation, collapse/project round-trip ownership, focus and layout regressions.
- Rust suite: **84 passed**, including UTF-8 boundary handling, path identity/discovery and independent capacity pools.
- `cargo check --manifest-path src-tauri/Cargo.toml --quiet`: passed. Existing dead-code and cfg warnings remain.
- Frontend unit suite: **121 passed** across 21 files, including pending-spawn resize and close races.
- Production build and emoji audit: passed. Vite reports the existing large main-chunk warning (~1.06 MB uncompressed).
- Native WKWebView debug preview: shell **PID 77119** and its screen survived collapse/expand, a second-workspace round trip, and designer → terminal skin round trip. `printf` generated Japanese text and a crab emoji correctly. Closing the disposable workspace reaped **PID 77943** while PID 77119 remained the only shell child of the preview. This is a short smoke, not the proposed soak.
- Native preview before the terminal fix reproduced shell replacement: PID 44969 became 47646 after collapse/expand. The first native picker discovered 38 repositories and opened only the selected Beads-Station workspace, with no automatic Claude chat.
- Preview is a temporary development `.app` wrapper around the debug executable using Vite. It is not the packaged release/Finder gate.

## Limits and next slice

This is not a completed daily driver. Local processes still terminate when the native window closes. Durable runtime attachment, the pinned herdr evaluation, structured Codex lifecycle, designer request/preview/revision flow, token-aware conductor routing and external pulses remain future milestones.

M1 still needs sustained output backpressure, large-output/paste stress and a measured native soak. No provider login, model call, token-usage claim, signed bundle verification or CMUX performance comparison was performed. Existing historical native verification issues remain open.

Tracking uses the recovered repository-local bd database. `Code-vnb` (workspace opening) and `Code-ecs` (bounded terminal lifecycle/capacity) are closed with verified evidence. bd itself automatically imported historical records; the passive export was not manually edited. The user's existing `package-lock.json` change (54 removed lines) is preserved.

Development-environment observation: Vite startup took 67.4 seconds during final verification. A native process sample showed synchronous dependency file reads blocked in `read`; frontend build/unit startup stalled similarly. This is not a measured application startup or memory result.

The final native review also caught opaque workspace IDs in the board heading. It now displays the project name and recognizes existing name-based project labels alongside stable IDs.

After the final board-name adjustment, the production build and focused Board regression test passed again (1/1). The full-suite totals above are from the immediately preceding foundation verification. No commit or push was performed; the native preview and its frontend server remain available for inspection.

## Development startup repair — 2026-09-10

The macOS login session supplied a 256-file soft limit to Node processes. Vite
could print `ready` and then stall while loading the frontend module graph,
leaving the native webview white. Frontend development, build, Vitest, and
Playwright commands now run through `scripts/with-fd-limit.sh`, which raises
only that child command to 8192 on macOS. The Rust application retains its
existing process-local limit bootstrap.

Observed after the repair: a cold `npm run tauri dev` reached Vite ready in 98
ms, Cargo completed without warnings, and both `/` and `/src/main.tsx` were
served in under 15 ms. `npm run build` completed in 3.14 seconds; the same build
before the wrapper spent 3 minutes 16 seconds blocked during module reads.
`cargo check` passed without warnings and all 84 Rust tests passed.

The frontend unit runner remained blocked inside a macOS file read in a Vitest
worker on this macOS 27 beta environment, even with one worker and the raised
descriptor limit. It was stopped rather than recorded as a pass or failure;
the last completed full frontend result remains the 121-test result above.
No provider login, packaged Finder smoke, or long native soak was performed in
this repair.
