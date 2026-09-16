# Acceptance journeys and evidence

Prepared 2026-09-16. These are future tests, not results. Use a disposable workspace
and profile, not the maintainer repository or the user's existing agent sessions.
Preserve evidence with private content redacted. Existing v0.1.0 test counts do not
prove these scenarios. See IMPLEMENTATION-PROMPTS.md for ownership.

## Automated gates

Run proportionate focused checks during a slice. At integration/release, from the
repository run the existing commands:

```sh
npm run build
npm test
npm run test:live
cargo check --manifest-path src-tauri/Cargo.toml --quiet
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
npm run tauri build
```

Browser tests use mock IPC; they do not prove WKWebView, PTYs or authentication.
Fake adapters should count starts, resumes, turns, cancels, tool calls and active
children, making forbidden side effects observable. Add tests for the new contracts,
not for incidental implementation details. Do not rerun full suites for markdown edits.

## Developer: native regression checklist, no provider spend

1. Launch the exact new bundle from Finder and record its version/commit/path. Open
   one disposable project; discovery must not open other workspaces or start agents.
   Main picker filters known projects, native Browse opens a folder picker, Cancel
   changes nothing, and Under folder has a visible bounded scope. Try spaces, Unicode,
   duplicate basenames, missing root and a large fixture tree.
2. Print `printf 'pid=%s marker=café-日本語\n' "$$"` in each shell. Create two workspaces,
   three panes and multiple tabs. Use enough numbered output to scroll back. Record
   PIDs, visible bottom prompt, cursor and viewport anchor. Use a local fake terminal
   application to exercise alternate-screen and cursor placement; use real Neovim
   without changing its configuration.
3. Cycle workspaces, terminal tabs, skins, zoom, terminal fullscreen and macOS native
   fullscreen at least 20 times. Resize, change scale/font, and emit output while a
   pane is hidden. Return both at the live bottom and while reading history. Bottom
   content must remain fully visible; history stays anchored; PIDs and typed drafts
   remain; input goes to the selected pane. Open Settings mid-cycle and confirm the
   terminal does not steal focus. Exercise IME and multiline Unicode paste.
4. Drag workspace and terminal tabs; reorder them with the keyboard. Confirm order
   after restart and active tab after close. Use next/previous/direct selection and
   asymmetric split focus while fullscreen. Split there and confirm the new pane is
   visible and existing PIDs/ratios survive. Test reduced motion and key conflicts.
5. In a fresh project, use Initialize Beads from Board, then the command palette/
   shortcut in a second disposable project. Verify correct target and usable board.
   Existing databases, missing bd and permission errors must not trigger reinit.
6. Record and name a recipe that opens a chosen workspace, splits right and shows
   the board. Edit a step and binding, replay, cancel, export/import and restart.
   Validate missing-target recovery. Confirm terminal input was never recorded.
7. Cmd+W, titlebar close and Cmd+Q each confirm appropriately. Cancel retains PIDs,
   draft and focus. With a durable owner enabled, choose Keep running and quit/reopen
   the GUI: same PIDs and screen must reattach. Separately stop/restart the daemon:
   show recovery, not live survival. Without that owner, the UI must say processes
   stop and must not offer a false persistence choice.
8. Restore fake Claude/Codex sessions: zero new turn/start-generation calls. No
   injected continue or shell-history replay. Distinguish renderer reload, GUI quit,
   daemon restart and machine restart in the evidence. Ordinary persistence tests
   must not launch real providers.

## Harness conformance matrix

Settings labels below are planned UI, not claims that these options exist today.
Use a fresh identical fixture workspace per profile. Switching profiles affects only
the next attempt. A mixed profile runs its declared stages; “test all” is a deliberate
batch with a visible estimated scope/budget, not the default Start behavior.

| Scenario | Native Codex | Native Claude | Adaptive Codex | Explicit mixed | Imported adapter |
| --- | --- | --- | --- | --- | --- |
| Availability, unsupported features and actual routing | required | required | required | each stage | capability-tested |
| Manual request with pulses Off | required | required | required | required | required for support |
| One attempt on duplicate Start/source delivery | required | required | required | stage/run IDs | required |
| Stream, reconnect, ordered output, exact cancel | required | required | root + children | all owned stages | required |
| No-generation restore, or truthful unsupported state | required | required | hooks included | every stage | capability-tested |
| Artifact, revision feedback and stale-approval rejection | required | required | required | final immutable revision | required for Designer support |
| Budget/failure/unknown ownership and recovery | required | required | child limits | stage limits | required |

Run this matrix with fixtures first. For real providers, authentication and generation
are explicit user actions and can consume allowance. An installed CLI is not proof of
login. Do not send credentials to the app assistant. Unsupported profiles stay disabled
or experimental; do not advertise all harnesses as interchangeable without evidence.

## User journey A: small read-only request

In Designer, choose one available harness, keep pulses Off, and create this request:

> Inspect only this disposable workspace. Summarize its top-level files in at most
> five bullets. Do not edit files, install dependencies, start servers, contact other
> services, commit or push. If it is empty, say so and stop.

Explicitly Start. Verify one request/attempt with the correct profile/provider. Switch
views/workspaces and return; no restart or duplicate output. Check real final status
and evidence. This tests provider routing, not artifact approval. Repeat on another
profile only when intentionally comparing it. An unavailable provider must offer a
clear setup path and preserve the draft.

## User journey B: complete Designer game and revision

Create a fresh disposable project for each harness under comparison, choose a profile
beside Start, and submit:

> Build a browser memory-pairs game using only local HTML, CSS and JavaScript. Use
> eight pairs of text symbols in a 4-by-4 grid, moves and match counters, Restart,
> keyboard-accessible cards, a win announcement, and a short unmatched-pair delay.
> A third card must not flip during that delay. No dependencies, external assets,
> network services, deployment, commit or push. Keep files inside this workspace.
> Add local opening instructions and checks performed.

Stay entirely in Designer: see plan/status/output, open captured preview and checks,
inspect diff/manifest revision, play through a match and mismatch, test third-flip
blocking, keyboard play, win and restart. The result must be a real captured artifact,
not a placeholder or an agent's textual assertion. Then request changes:

> Keep the game. Add a visible high-contrast keyboard focus indicator and a
> reduced-motion mode following the browser preference. Change only those items.
> Retest keyboard play and Restart. Do not deploy or add dependencies.

Verify new attempt/revision, old approval invalidation, unchanged feedback history,
new preview and checks. Approve the exact current revision. After approval, alter a
fixture artifact or capture a new revision: stale approval must not authorize it.
Approval must not publish/merge/post. Reload/reopen and confirm the same records and
approved hash remain. Test an unsafe HTML fixture separately: it cannot call Tauri
commands, read arbitrary local files, or gain network access from the privileged app.

## User journey C: cancel and recovery

Use a fake long-running worker with controlled output/exit for deterministic races.
Cancel during output, after exit, with pipes left open, and after UI reconnect.
Verify exact ownership/reap/drain, bounded timeout and honest unknown state. Other
workspaces survive. Crash between launch intent and handle registration; reconcile
before retry. No automatic duplicate worker on restart. For an intentionally running
real game request, Cancel then Check status once; partial files are not rolled back.
Do not start another paid run solely to generate a cancellation race.

## User journey D: configuration, connections and pulses

1. On a clean installed-app profile with no development shell, configure a fixture
   stdio server using Browse executable. Also test a fixture HTTP server. Validate
   missing dependencies and authentication instructions without a source checkout.
2. Configure a source/query/mapping/workspace with ingest-only default. Scan now;
   accept a staged request. Rescan unchanged data: no duplicate request or model call.
   Enable a schedule; restart and sleep/wake; verify cursor and bounded catch-up.
3. Enable optional triage for changed items using an available configured small model
   only when deliberately testing paid behavior. Fixture tests prove one call per
   changed revision, limits and no calls when unchanged. Disable pulses and complete
   a manual request immediately. No connection is necessary for local work.
4. Test a prompted config proposal such as “Scan this source every 30 minutes during
   weekday working hours, ingest only.” Inspect impact/diff before Apply. The prompt
   may consume tokens; manual editing must create the same configuration without it.
   Edit JSON concurrently, test conflict/invalid schema, undo and redacted export.
5. Test expired auth, denied tools, offline server, pagination duplicates, rate limits,
   changed schemas, malicious request instructions and unknown write outcome using
   fixtures. Real GitHub/Figma/Jira account checks are separate user-selected tests.
   No automatic external posting. Internal work/work follows prompt 14 in its own
   environment and is not a prerequisite for the public release.

## Performance and release evidence

Measure the master-plan budgets with identical hardware/font/workspace/output load,
multiple warm samples and a 30-minute idle/active soak. Report full app/WebContent/
runtime process-tree CPU and memory, provider processes separately, input latency,
switch latency, startup, listener/PTY/fd counts and hidden-pane output behavior.
No-agent idle, pulses Off, deterministic scan, and AI work are separate measurements.
Reject persistent resource growth or lost input even if average latency looks good.

Upgrade a disposable v0.1.0 profile with the new DMG; retain workspaces, bindings and
appearance. Verify config migration, backup/rollback limits and missing binaries on
Finder launch. Build a fresh bundle after final changes. Record exact commit/tag,
version metadata, native smoke, frontend/unit/browser/Rust results, SHA-256 checksums,
install/upgrade steps, architecture/OS support, signing/notarization status, known
limitations, checklist and screenshots from that build. Never reuse v0.1.0 assets.
Publish only when separately requested. Keep preview status until the release policy's
Developer and Designer gates are satisfied; unresolved mandatory gates block readiness.

For each run save: date/hardware/build/workspace; scenario; harness/version/config
revision; requested and observed provider/model/effort; request/run/attempt/artifact
IDs; PIDs and turn counts before/after; expected/actual behavior; checks performed;
redacted screenshot paths; usage if reported; failure and reproduction. Unknown stays
unknown. Record unrun tests explicitly rather than marking them passed.
