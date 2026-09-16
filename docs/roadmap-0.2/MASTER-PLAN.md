# Beads Station: 0.1.x stability and 0.2.0 working Designer

Planning snapshot: 2026-09-16. Status: proposed implementation, not delivered.
Entry points: [research](RESEARCH.md), [copy/paste prompts](IMPLEMENTATION-PROMPTS.md),
[test journeys and release gates](ACCEPTANCE.md).

## Baseline and authority

Inspected clean main at `f61430b5a0c74041db036ddad1bcabb953069f00`. Local v0.1.0
resolves to that commit. [Published prerelease](https://github.com/Erscheinung/Beads-Station/releases/tag/v0.1.0)
was confirmed through GitHub on this date. README and release notes correctly
describe Designer as a prototype. Their historical test counts belong to that
build, not future work. No runtime reproduction, provider call, benchmark, install,
or application-code change was performed for this plan.

Read AGENTS.md and CLAUDE.md for tracking and implementation rules. Consult
`docs/ASTRA-DAILY-DRIVER-PLAN.md`, `docs/FOUNDATION-VERIFICATION.md`, and
`docs/PRACTICAL-TEST-WORKFLOW.md` for architecture and earlier evidence. Current
source, reproduced behavior, and this user request outrank old completion claims.
Do not revive historical review-agent requirements or old machine paths.

The user requests Developer bugs/features in a 0.1.x workstream and a functional
Designer/orchestrator for 0.2.0. Compatible preview additions in that workstream
are an explicit exception to the usual patch-only-fixes convention. Assign each
actual patch version only after its scope and evidence are known. Changes to
runtime ownership or incompatible configuration require explicit migration notes;
do not label a breaking workflow a routine patch. Do not change the published
v0.1.0 tag/assets. This plan updates future direction without rewriting its notes.

## Product and performance rules

1. The terminal is a daily driver even with all providers, connections, and pulses
   disabled. Discovery, navigation, resize, configuration reads, and idle scheduling
   must not call a model. Configuration prompting and enabled AI triage can consume
   tokens and must make that visible.
2. Keep one owner per terminal process and one owner per run. Screen state,
   geometry, viewport anchor, selected pane, and input focus are related but separate.
   UI visibility is not process lifetime. A restored transcript is not a live worker.
3. Minimize idle CPU, allocations, observers, disk writes, and IPC. Bound buffers,
   requests, retry counts, and concurrent work. Event-driven updates and targeted
   invalidation precede polling. No periodic terminal repaint or model heartbeat.
4. Optimize the current React/xterm system from measurements. Svelte is a learning
   and feasibility experiment, not a presumed cure for PTY or native geometry bugs.
5. All settings paths work for Applications/DMG users without a source checkout.
   Simple presets first; advanced detail on demand. Manual edits and prompt edits
   operate on the same versioned configuration, with validation, history, and undo.

Retain provisional budgets from the prior plan: cold usable workspace ≤2 seconds,
warm workspace switch p95 ≤100 ms, local key-to-paint p95 ≤50 ms, idle app/runtime
CPU around ≤1%, no-agent memory around ≤250 MB. These are targets, not measured
facts. Record hardware, process tree, sample size, warm/cold conditions, and provider
processes separately. Investigate >10% regression against a repeated warmed baseline;
change targets only with recorded evidence. A 30-minute soak must show no monotonic
PTY, observer, file-descriptor, or retained-screen growth after disposable panes close.

## Workstream A: Developer 0.1.x

| Slice | Owner and dependency | Outcome and acceptance |
| --- | --- | --- |
| A1 terminal geometry/focus/scroll | Sol; first | Reproduce screenshots 2–4 in a packaged app; repair the shared lifecycle. Bottom prompt, cursor, anchor, PID and input survive switches/fullscreen. Test both normal and alternate buffers. |
| A2 close/quit guard and restore contract | Sol; after A1 | Cmd+W, window close, Cmd+Q, menu quit use consistent confirmation. Cancel preserves input; saved state restores without sending a provider turn. Live survival is accepted only with A3. |
| A3 durable terminal owner | Sol; after A2, bounded Herdr evaluation | Prove Herdr transport/packaging or select one minimal local daemon fallback. Closing GUI and reopening reattaches same live PIDs. Server/machine restart is recovery, never PID survival. Share ownership contract with B1. |
| A4 workspace finder/Browse | Luna; after A1 | Main input fuzzy-filters cached project/path entries immediately; right button is native Browse. Recent ranking is explicit; bounded current-directory search is available. No automatic opening or broad scan per keystroke. |
| A5 initialize Beads | Luna; independent of A4 UI files | Board/explorer empty state offers Initialize Beads and a configurable command. Correct canonical project only; distinguish absent database, missing bd, corruption, and permissions. Refresh after verified success. |
| A6 reorder and navigation | Luna; after A1 | Drag workspace and terminal tabs; keyboard next/previous, direct select and reorder. Preserve IDs, PIDs, order and selected context. Fullscreen navigation and geometric focus work. |
| A7 named interaction recipes | Luna after A6 command contract; Sol for execution boundary | Record semantic app actions, name/edit/bind/replay them, with parameters and cancellation. Zero recorder overhead when off; no raw terminal keystroke logging. |

A3 can be a separately gated delivery after an initial A1/A2 patch. A2 alone must
not close the user's persistence bug. If A3 misses the Developer patch schedule,
keep its acceptance open and name it as a 0.2.0 dependency; do not claim restoration
satisfies process persistence. Broad runtime replacement must not delay a verified
clipping fix. A4 and A5 may run independently; A1/A2/A3/A6 are sequential where
they share terminal lifecycle files. One writer per file.

### A1: user screenshot evidence and investigation

Screenshot 1 shows the picker with the right action opening a recent project.
Screenshot 2 shows the lower terminal region clipped after switching; screenshot
3 is the user's complete-bottom comparison. Screenshot 4 illustrates a return to
an earlier scroll position. The user reports cursor/focus loss as well. These are
reported symptoms, not proof of a Codex-specific or React-specific cause. Original
images were supplied in conversation; do not depend on ephemeral clipboard paths
for future tests or commit their private terminal contents. Capture sanitized
before/after evidence in a disposable project.

Inspect `src/lib/terminalSessions.ts`, `Terminal.tsx`, `TerminalPanes.tsx`,
`src/state/termPanes.ts`, workspace switching, `ClaudeChat.tsx`, and native `pty.rs`.
Record container bounds, actual font metrics, xterm rows/cols, backend PTY size,
device scale, scroll position, buffer kind, activeElement, focus owner and session ID
at hide/show/resize. Check zero-sized fits, stale ResizeObserver callbacks, reveal
ordering, flex/min-height/overflow boundaries, lost active pane, delayed paint, and
chat remount/auto-scroll effects. Inspect only the relevant source; fix demonstrated
causes. Do not add sleeps, repeated fit polling, scroll-to-bottom-on-every-return,
forced focus after Settings, or remounts to hide the bug.

Keep a per-session viewport anchor and follow-output flag: bottom followers follow;
users reading history remain anchored despite new output. Handle reflow and bounded
history eviction gracefully. Track chat anchors by conversation/message identity,
not only pixels. Preserve an in-progress input draft and selection. Restore focus
only when returning to the previously active terminal context; never steal it from
dialogs, composition, menus, or another workspace.

### A2/A3: close and resume semantics

Default close intent presents Cancel / Close and stop sessions; add Keep sessions
running only when a verified durable owner is available. Explain affected scope and
ongoing model work. Treat native fullscreen, terminal canvas fullscreen, pane zoom,
renderer reload, GUI quit, daemon stop and OS restart as different events. Suppress
duplicate dialogs from overlapping native/frontend handlers. Forced OS termination
cannot be guaranteed to show confirmation; recover from that separately.

Persist canonical workspace IDs, cwd, tab order, split tree, selected panes, bounded
screen snapshot, provider-observed session/thread IDs, harness/config revision and
runtime handles. Write atomically off hot paths; do not serialize each output byte.
Never replay a shell command/history automatically to reconstruct work.

Desired default after opt-in: automatically restore visible context and attach to
existing live sessions with no new prompt. For stopped supported provider sessions,
use an observed session ID and a proven no-generation resume path. Codex thread
read/resume and turn/start are distinct; test the installed version. If a harness
cannot prove idle resume, show restored history with Resume ready for explicit intent.
Never inject `continue` on reopen. An already running model may continue spending
while the GUI is closed; detach itself adds no generation, but is not a spending
pause. Show this in the close choice. Track no-new-turn evidence, not invented quota.

### A4: decided picker interaction

Use one prominent combobox, `Find a workspace or enter a path`, and a stable Browse
folder button opening a native directory picker. Empty query lists recent explicit
opens first, then discovered projects; query results rank exact/prefix/fuzzy matches,
with recency as tie-breaker. Display enough path to disambiguate duplicate names.
Enter opens the highlighted entry, or an explicit valid path; typing opens nothing.

Replace the redundant second text input with a compact scope selector: Known projects
(default) / Under folder. Under folder shows its root and Change folder. It lists
directories/projects, not file contents; offer a separate future content-search
command instead of making workspace opening ambiguous. Search a bounded cached
index built on explicit scope selection/refresh, cancel stale work, cap depth/results,
honor ignore rules and avoid symlink cycles. Filesystem work stays off the UI thread.
No ripgrep/fzf installation requirement in the DMG. A small in-process matcher is
sufficient initially; benchmark large roots before adding indexing dependencies.

### A5–A7: commands, navigation, recording

Beads initialization must use the installed CLI's supported init/bootstrap semantics
after checking its version/help. Existing tracked exports may require bootstrap;
an entirely new project requires initialization. Never overwrite an existing store,
initialize a parent/neighbor, or treat a CLI failure as missing Beads. Show what will
be created, run once on intent, then verify and reload the board. Missing bd links
to installation guidance; failure preserves ordinary terminal use.

Preserve shipped Cmd/Ctrl+Alt+Arrow focus, +Shift resize, Cmd/Ctrl+Shift+Enter canvas
fullscreen, legacy configured bindings, Cmd/Ctrl+P leader and Neovim Escape. Audit
the current command registry before allocating defaults. Proposed optional shortcuts:
workspace next/previous Cmd/Ctrl+Alt+]/[, workspace direct Cmd/Ctrl+Alt+1…9;
terminal next/previous Cmd/Ctrl+Shift+]/[, direct Cmd/Ctrl+Shift+1…9. Only activate
defaults after native conflict checks; otherwise leave a command unbound and suggest
it in Settings. Offer an optional Vim-direction preset without intercepting h/j/k/l
in editors. Native OS app-switching keys are not app workspace keys.

Directional focus uses split geometry and a deterministic nearest-neighbor tie-break,
with documented boundary behavior. Fullscreen stays fullscreen while revealing the
target pane/workspace; preserve each workspace's selected pane and split ratios.
Splitting while zoomed/fullscreen creates one session and reveals the resulting
layout; the fullscreen canvas can remain active. Reorder is separate from moving
a pane between workspaces (deferred unless separately implemented). Support keyboard
reorder and pointer drag thresholds with accessible announcements. Short optional
focus/position transitions respect reduced motion; never animate terminal dimensions
frame-by-frame or refit PTYs on every animation frame.

Recipes record app command IDs with typed arguments and semantic targets, not mouse
coordinates or arbitrary keys. Example: “Review workspace” → select project → split
right → focus right → show board. Recorder Start/Stop/Cancel is explicit; after stop,
name it, inspect/reorder/remove steps, bind a key and save. Add expected context,
missing-target behavior, bounded wait conditions, timeout, cancellation, recursion
limit and version migration. Privileged steps use the same action authorization as
manual invocation. Terminal command steps are an explicit advanced action with
reviewable arguments, not inferred by snooping terminal input. Secrets and clipboard
contents are excluded. Prompted edits propose the same validated recipe structure.

## Workstream B: 0.2.0 Designer and orchestrator

All five opening themes are in scope: working Designer, orchestration with/without
pulses, flexible MCP/settings/prompt configuration for installed apps, interchangeable
Claude/Codex/mixed/imported harnesses, and documented future work/internal integration.
The private work adapter is a future extension, not a false 0.2.0 release requirement.

| Slice | Ownership and dependencies | Deliverable |
| --- | --- | --- |
| B1 shared run ledger/ownership | Sol; coordinate A3 | Durable attempts, admissions, fencing, reconciliation, cancellation, ordered events and attempt-owned merge slots. |
| B2 harness/provider profiles | Sol after B1; Luna settings UI afterward | Native Claude, native Codex, Codex adaptive profile, bounded mixed profile, validated import and immutable per-run configuration. |
| B3 Designer vertical journey | Sol artifact/approval contract; Luna UI after contract; B1/B2 | Persisted request → plan/run → actual artifact/preview/checks → revision → exact approval. |
| B4 configuration/connections | Sol config/auth backend; Luna form/prompt-diff UI | Versioned settings, MCP stdio/HTTP client, manual/import/prompt routes, diagnostics and safe auth in DMG. |
| B5 optional intake pulses | Sol scheduler after B1/B4; Luna panel afterward | Durable source cursors, mapping, dedupe, optional bounded Luna/Haiku triage, manual scan and no-pulse operation. |
| B6 packaged release acceptance | Sol owns evidence synthesis | Every supported profile passes the contract suite; native Designer journeys and update/restore tests; no prototype-only release claim. |

### B1: one run service

Manual requests, local Beads events and external intake produce the same normalized
request record. Persist workspace ID, ticket ID, request revision, source identity,
attempt ID, provider session ID, harness ID/version, resolved model/effort, permission
policy, budget, timestamps and outcome. Store request/run/config data in an app-owned
transactional ledger; do not directly modify Beads' Dolt data. Synchronize Beads via
its CLI, with durable operation IDs and retry/reconciliation records.

Before spawn, atomically claim an attempt with an idempotency key, lease and fencing
generation. Two UI windows, manual Start plus pulse, or duplicate source delivery
cannot create competing owners. Persist launch intent first. A crash between spawn
and recording its handle produces unknown ownership requiring reconciliation, not
blind retry. Verify runtime identity beyond PID to protect against PID reuse.

States: queued → planning (optional) → running → verifying → needs_review → approved;
also blocked, failed, cancelling, cancelled, unknown/recovering. Model completion
does not imply validation or approval. Persist transitions before UI notification;
snapshots carry sequence watermarks and bounded replay. A stale attempt cannot
overwrite a new attempt, emit final approval, or release its merge slot. Slots must
include workspace/ticket/attempt/fencing generation; do not retain `builder:{bead}`
as the sole owner identity. Serialize conflicting changes and preserve dirty files.

Separate pause intake, stop scheduling, cancel attempt, and detach UI. Cancellation
reaches the exact child/process group, reaps, drains bounded output, and preserves
unknown ownership on timeout. Never release admission just because UI lost contact.
Offline/local manual work remains usable. Implement schema migrations and recovery
for corrupted records with actionable diagnostics, without reinitializing user data.

### B2: harnesses and routing

A harness is an execution workflow; a provider is a model interface; a runtime owns
processes. Keep them separate so selecting a workflow never silently replaces PTYs.
The native default runs one bounded worker. Sol-led adaptive Codex delegates to Luna
only where useful. A mixed profile can assign explicit stages to Claude and Codex;
it must not launch both for every request. No fixed review stage from imported
instructions may silently override this project's no-review contract.

Define a manifest with schema/version, name, provenance/digest, executable plus argv,
cwd rules, protocol version, supported providers, capabilities (start, events, cancel,
status, idle resume, artifact output), model/effort policy, tool permissions, env
references, limits, and hooks. Use structured arguments, never shell interpolation.
Import previews required binaries, capabilities, config changes and executable hooks.
Plain instruction packages import as instruction profiles, not fabricated runtime
adapters. Unknown adapters can be stored disabled and tested against fixtures.

Settings → Agents offers recommended presets, Import, Duplicate, Configure, and Test
locally. Designer shows the selected profile beside Start, with advanced provider/
model/effort overrides collapsed. Show requested versus provider-confirmed routing,
and unknown when unreported. Snapshot a profile at attempt start; changing Settings
affects future attempts only. Never infer login from binary discovery.

Budget wall time, concurrent children, turns, retries, output and optional tokens/cost
where observable. Resolve actual available models from configured providers; do not
hardcode historical names or silently reroute on unavailable Luna. Escalation is
bounded and explained; missing tools/auth are environment failures, not a reason to
buy a larger model. Run identical fixture contracts for every advertised adapter.

### B3: wire every Designer surface

| Existing surface / source | Required 0.2.0 behavior |
| --- | --- |
| DesignerShell request creation/detail | Durable title, outcome, references/attachments, scope and acceptance; recoverable loading/empty/error states; draft preservation; workspace qualification. |
| Provider dropdown, Start/Cancel/Check status | Shared B1/B2 commands and real availability. Idempotent Start, exact cancellation, reconnect, visible current profile and actionable failures. |
| Everyday/Heavy tier buttons | Replace misleading implicit mappings with named editable execution presets showing effective routing. Do not claim a tier was dispatched unless observed. |
| Request changes / unavailable artifact approval | Capture immutable artifact revision, preview, checks, revision feedback and exact approval. Disable stale actions and explain why. |
| GateCockpit | Distinguish ordinary Beads human gates from artifact approval. Resolving an unrelated gate cannot approve changed files. |
| ConductorControl/footer/ActiveAgents/Timeline | Same persisted run service and events; real progress/blocked/unknown states, no fabricated agents or status derived only from terminal text. |
| SensorsPanel | Surface optional configured sources/pulses, last scan, next scan, failures and staged intake. Do not silently launch legacy sensor work. |
| BeadGraph | Secondary dependency view synchronized with request state; preserve current readable layout. It is not the required request-creation journey. |

Artifact manifest: run + attempt + immutable revision + workspace/source commit +
relative paths and hashes + capture time + validation results. Copy/freeze artifact
content or otherwise guarantee immutable revision access. Constrain paths and symlinks;
bound file types/sizes. Preview text/diff/images/static HTML in isolated content with
no Tauri IPC or implicit network access. If a dev server is needed, explicitly own
its process/port and lifecycle. Do not load arbitrary project scripts with app privilege.

Approve records the exact manifest and validation state transactionally. Changed
content or a new revision invalidates the old actionable approval even if its history
remains visible. Request changes preserves feedback and starts a distinct attempt.
Approval is local acceptance; merge, publish, deploy or external post are separate
explicit actions. Designer must complete the full journey without terminal knowledge.

### B4: easy configuration for DMG and source users

Provide Settings categories: General, Appearance, Keyboard & Recipes, Agents,
Connections, Automation, and Advanced. Search spans them. Each connection has a name,
transport, endpoint/command, workspace scopes, tool selection, auth status and Test.
Use sensible presets for common services but allow any schema-compatible MCP server;
service-specific request mapping is still needed, and not every MCP is an intake source.

Persist versioned non-secret config under the OS app configuration directory resolved
by Tauri, never inside the signed bundle. Provide Open config folder, Edit JSON,
Import/Export (redacted), Restore defaults per section, and revision history/undo.
Optional project overrides have visible provenance; effective precedence is defaults
→ user → trusted workspace → explicit attempt. Workspace content cannot silently
grant permissions, enable tools, spend budget or override secrets.

“Change settings with a prompt” opens a scoped assistant: read sanitized config/schema,
produce a structured patch, show plain-language impact and exact diff, validate, then
Apply. Include a no-model form/manual route. Stale revisions use compare-and-swap;
reject invalid proposals atomically and keep last-known-good config. Test import/export,
migrations, concurrent manual/UI changes, broken JSON, undo and profile edits mid-run.
No arbitrary code execution through a config proposal. Prompting itself may cost tokens.

MCP support: stdio servers with explicit executable/argv/cwd and per-process env secret
references; remote Streamable HTTP with supported authentication discovery. Authenticate
through browser/system credential storage, never ask users to paste tokens into prompts.
HTTP and stdio have different auth boundaries; expose missing capability honestly.
Test expired/revoked auth, reconnect, rate limits and tool-schema changes. Logs/exports
must redact credentials. Tool descriptions and imported requests are untrusted data;
they cannot change app authority or enable auto-execution. Allow tools by explicit
capability and scope, not by trusting server read-only annotations alone.

Finder launch does not inherit a developer shell's PATH. Resolve/check binaries in
onboarding, allow Browse executable, show platform/architecture/runtime requirements,
and test a path with spaces. Bundled sidecars need pinned versions, licenses, packaging
and signing evidence. Do not silently download runtimes, run package installers, or
edit ~/.codex / Claude configuration when importing an app profile.

### B5: optional pulses and source intake

The local orchestrator works with no network connections and pulses Off. Manual
Start and local request events feed admission immediately; a timer must not be the
only path to run a ticket. One-shot Scan now and optional scheduled intake are separate
from starting workers. Rename internal legacy “pulse” execution concepts where needed
so the UI's scan pulse does not mean “launch an LLM every interval.”

Source pipeline: fetch changed items deterministically → normalize + deduplicate →
optional AI classification → staged request → policy-based admission. Persist cursor,
source revision, mapping revision, last scan, next scan, errors and idempotency key
(connection/tenant/source object/revision). Advance cursor only after durable intake.
Handle pagination, deletes, edits, replay, offline retry, rate-limit/backoff, timezone,
sleep/wake, and restart without a catch-up storm. Webhooks are optional only when
reachable/authenticated; a DMG must not require a public inbound server.

Users choose connection/tool/query, field mapping (title/body/reference/acceptance),
destination workspace, cadence/quiet hours, enabled state, and ingest-only versus
explicitly authorized auto-run policy. Default ingest-only. AI triage can select a
configured Luna/Haiku-class model, with actual availability checked, bounded context,
budget and one classification per changed revision. No changes means zero model
calls. If users explicitly request periodic semantic scans, show that they may cost
tokens even without new accepted work. Cache results and provide deterministic rules
as a complete alternative. Pausing pulses cannot strand manual requests.

Start with a fixture MCP and a GitHub intake mapping, then Figma/Jira mapping examples
against exposed schemas. Generic stdio/HTTP configuration plus importable mappings is
required for 0.2.0; label any untested service preset experimental. External writes
use an exact destination/content preview, explicit action, durable outbox and
idempotency/reconciliation. Reads never imply authority to post to GitHub/Jira/Teams.

## Future authenticated enterprise extension

Create a future adapter spike for `work-auth-mcp`, using internal `work-tools` for
Jira, GitHub and Teams. The user will run Sol where these tools are exposed. Their
tool names, schemas, tenant requirements, permissions, auth and packaging are unknown
here. Do not invent them, search private credentials, or ship an assumed endpoint.
Discover documented tools there, let the user complete approved auth, map the verified
read capabilities into B4/B5, and test re-auth/revocation with redacted evidence.
Any write/post is a separate explicitly scoped test. The prompt is in the prompt pack.

## Execution and tracking

Sol owns decisions, bounded briefs, dependency ordering and evidence synthesis. Luna
owns complete small implementation slices and focused validation. Sol owns the risky
runtime/approval/config transaction slices requested here. Use configured roles, not
new model overrides. Do not inspect/diff-review worker-authored code or add a reviewer;
accept reports and route failures to the same owner. Native validation checks behavior.

Before code, verify `git status`, `git config --get beads.role`, `bd where`, and
`bd prime`. Reconcile historical IDs: `Code-0cp.1/.3/.4/.5/.6/.10`, `Code-am5.1/.2/.3`,
`Code-yfb`, `Code-t3j`, `Code-9ff`, `Code-oan`, and `Code-1dh`. These are lookup leads,
not claims about current status. Create new regression children when appropriate;
do not reopen unrelated closed work. Read back each write. A/B labels in this plan
are planning labels, not invented Beads IDs.

Suggested order: A1 → A2 → A3/B1 contract → A4/A5 → A6 → A7 → B2 → B3 → B4 → B5 → B6.
Independent small UI tasks may run while Sol resolves a separate backend contract,
with explicit file ownership. Do not start a broad migration while stabilizing terminals.
After each slice record actual files, tests, native evidence, uncertainty and next
bounded task. Release only after ACCEPTANCE.md gates pass on the exact candidate.
