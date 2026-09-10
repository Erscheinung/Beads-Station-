# Workspace and terminal foundation — 2026-09-09

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
