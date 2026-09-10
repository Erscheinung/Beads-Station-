# Astra plan: a daily-driver Beads Station

Prepared 2026-09-09. Scope: source/history investigation and product planning, no implementation. Starting point: `exp/just-works-backbone` at `7a027c6`.

## Recommendation

Make the ordinary work loop excellent before adding more orchestration surfaces. The product currently centers a board, issue tree, terminal strip, and always-present Claude chat simultaneously. Each consumes space and lifecycle work before the user expresses intent. A theme change cannot resolve that interaction model.

The distinctive product should be **a durable workspace where a ticket becomes visible, reviewable work**. Developers start in their terminal/editor. Designers start with a request and see a preview and a clear decision. Both use the same project, ticket, run, artifact, and approval records. The conductor handles the boring coordination reliably and spends tokens only on uncertainty and implementation.

Do not promise performance beyond CMUX without measuring the same workload on this Mac. Tauri's small bundle alone does not establish low total memory or terminal latency.

## Evidence and branch reconciliation

Read README.md, CLAUDE.md, BEADS-CONTEXT.md history sections, package/test configuration, the project/pane/provider/conductor/designer source paths listed in AGENTS.md, and passive issue export. This was a targeted architectural review, not an exhaustive line-by-line audit or live UX test. The supplied screenshot is the observed startup failure; performance diagnoses below are source-supported risks, not newly measured benchmarks.

`origin/r12-live-verify` at `e959d17` is already an ancestor. The eight newer commits include spawn governance (`841f452`), reduced git refresh (`45d360f`), split layout persistence (`a9f35e0`), soak tests (`e6fe7c7`), theme import (`7b9bb44`), and documentation/tracker updates. Remote heads were checked with `git ls-remote`; no missing branch work was found. Preserve the pre-existing package-lock.json modification.

README's Phase 5 status and Gateway-only setup are obsolete. Historical completion notes sometimes mean source/mock coverage, not successful native operation. Existing export has 126 closed, 9 open, and 5 in-progress records; it is not proof of the live database's state.

## Product critique and concrete gaps

| Priority | Evidence | Consequence and proposed change |
| --- | --- | --- |
| P0 | `projects.rs::code_root()` joins HOME with `Code`; `read_dir` aborts the scan | Explains screenshot exactly. Configurable roots, suggested `~/Desktop/Code`, open-folder recovery and partial results when a root is missing. |
| P0 | All discovered projects enter TabBar; store auto-selects first/persisted item | Discovery and open workspace state must be separated. No session minting/process launch during discovery. |
| P0 | `spawngov.rs` has six shared permits held throughout Claude session lifetime | Enough persistent sessions can block bd/git refresh indefinitely. Reserve short-operation capacity, separately cap agents and PTYs, expose queue reason and wait time; do not merely raise the limit. |
| P0 | `Terminal` always calls `pty_spawn` on mount; cleanup disposes xterm but deliberately leaves PTY alive; collapse unmounts TerminalPanes; renderer selects active tab | Remount paths risk replacement shells and abandoned processes despite persisted IDs. Establish attach/detach ownership and reproduce tab/project/collapse/skin/split transitions with shell identity probes. |
| P0 | PTY reader emits before frontend listener is installed; decodes each 4096-byte read with `from_utf8_lossy` | Early output can be lost; split multibyte characters can corrupt. Add an attach-ready/replay protocol, bounded byte buffering, streaming decoding, ordering and backpressure. |
| P0 | Window close explicitly kills local PTYs/Claude children; pane persistence strips runtime handles | Layout restore is not runtime continuity. Treat detach, close pane, quit UI, and stop runtime as different actions. |
| P1 | `App.tsx` mounts bottom ClaudeChat after morning confirmation; chat starts on mount | Visiting workspaces can accumulate agents. Make agent creation explicit and share one pane/session model instead of a separate mandatory chat. |
| P1 | Basename project IDs; `.env`, sensors, daily paths and bd federation retain old laptop references | Same-name repos can collide and clone setup is brittle. Canonical-path-backed stable IDs, versioned migration, configurable optional integrations, standalone terminal mode when bd is missing. |
| P1 | `BeadGraph.onActivate` ends with `void issue` and switches to terminal | Clicking a ticket does not actually bind the work. Create Run(ticketId, projectId, intent) and retain designer context. |
| P1 | Designer tier card says medium/xhigh; backend chooses fixed Claude model strings and passes model, not effort | UI overstates control. Capability-driven provider/model/effort selection; settings acknowledge backend errors and show effective policy. |
| P1 | herdr uses `conductor-{repo}` name, creates a pane every pulse, has no client transport deadline; cancel returns Completed | Fanout identity collisions, hangs and false success are possible. Unique run/attempt names, durable registry, bounded RPC, real cancel acknowledgment and explicit unknown outcome. |
| P1 | herdr mode selected from socket-path existence; comments mention fallback but the true branch returns the herdr result directly | Validate protocol and health. Never blindly replay a failed/ambiguous remote launch as a local launch; reconcile first to avoid duplicate work. |
| P1 | Sensors currently ingest local material; no GitHub/Jira connector references found in application source | External pulse sync is roadmap work. Build durable local requests and an outbox before claiming integrations. |
| P1 | Mock Playwright tests and prior manual gates remain distinct | Passing tests cannot certify real shell persistence, auth, native rendering, or designer completion. Add explicit native release evidence. |

Preserve the useful work: React external project store, bd snapshot cache, safe listener cleanup, split/tab/zoom/focus controls, per-project layouts, issue gates, fanout cards, palette-driven terminal surfaces, Ghostty-style theme import, and existing test fixtures.

## Experience to build

### Developer

Default window: compact workspace rail, one dominant terminal/editor canvas, restrained status/attention indicators. Board, files, changes, and runs are switchable views or temporary inspectors. Remove the compulsory bottom chat and repeated pane chrome. Open a folder or recent workspace explicitly; pin/reorder/close workspaces independently of disk discovery.

One command palette covers open workspace, split, focus, editor, run agent, review changes, jump to waiting agent, and appearance. Offer CMUX-like application shortcuts while keeping terminal/Neovim input authoritative. Handle IME, composition, Option keys, clipboard, bracketed paste, links, selection, fullscreen, and macOS focus restoration explicitly. Notifications should identify the waiting run and take the user to it without stealing focus automatically.

Run installed Neovim with the user's existing LazyVim setup inside a real terminal. File-open should target/reuse an editor pane with safe file/line arguments. A separate optional NVIM_APPNAME profile is appropriate only if the user wants a managed profile. Run editor health checks during implementation; don't port Lua plugin functionality to the web.

Keep existing theme import and improve its preview, font/line-height controls, contrast, focus/selection states, and light-mode parity. Developer chrome can be compact; designer typography should favor readable proportional text and comfortable spacing. Reduce borders and redundant labels; use hierarchy and one clear accent. Imported theme colors should drive the entire relevant shell consistently without a terminal remount.

### Designer

Default view: Requests, In progress, Needs your review, Completed. Project selection is visible. Primary action: New request. Capture intended outcome, relevant page/file, reference image or link, constraints, and acceptance criteria. Offer small clarifying questions only when the request is insufficient to run.

The request detail shows a plain-language plan, current progress, preview, before/after, validation evidence, and Request changes / Approve. Dependencies and detailed agent logs are expandable. Keep pause, cancel, budget controls, and error recovery accessible. Avoid implementation jargon such as beads, wisps, tier ceilings, or gate molecules in the primary flow.

Publish/sync is an explicit action with destination and exact content preview. First complete a local request-to-reviewed-artifact flow; then GitHub draft issue/PR integration; then Jira. A designer must never need to switch skins to complete the standard journey.

## Runtime and reuse decision

Keep boundaries small: UI → workspace/session service → runtime adapter; conductor → run service → provider adapter; connectors → normalized requests + outbox. Prefer one local runtime owner. React renders subscriptions; it does not own worker lifetimes.

| Candidate | Useful reuse | Decision |
| --- | --- | --- |
| [CMUX](https://github.com/manaflow-ai/cmux) | Workspace rail, attention navigation, command/socket semantics, Ghostty appearance, session restore UX | Borrow interaction patterns. Swift/AppKit + libghostty is not a React component transplant. Retain xterm initially; consider a native renderer only after terminal profiling proves it necessary. README currently identifies GPL-3.0-or-later: check exact pinned source/license before copying code. |
| [Herdr](https://github.com/herdrdev/herdr) | Background terminal ownership, agent states, socket control, detach/reattach | Preferred bounded evaluation. Existing bridge is partial. Pin a version and prove raw terminal attachment or an appropriate supported client protocol; agent.read text alone cannot preserve full terminal state. |
| [jcode](https://github.com/1jehuang/jcode) | Optional Rust harness, persistent serve/connect workflow and local-provider support | Evaluate as a provider/harness adapter after native Claude/Codex work. Do not replace project orchestration wholesale or stack two schedulers. Repo identifies MIT; upstream efficiency claims remain unmeasured here. |
| [LazyVim](https://www.lazyvim.org/installation) | Real editor configuration and its health workflow | Use installed Neovim and existing config. Avoid an editor rewrite and unsolicited config replacement. |

Sources checked 2026-09-09. Herdr's former ogulcancelik URL redirects to herdrdev. Its [session documentation](https://herdr.dev/docs/session-state/) distinguishes a live server surviving client detach from reconstruction after server/machine restart. CMUX's [README](https://github.com/manaflow-ai/cmux) likewise distinguishes saved session reconstruction from live process persistence. Apply that distinction to every app status label.

Herdr evaluation must establish: protocol/version negotiation, launch/discovery from Finder, session list, output snapshot/replay and streaming, input/resize, agent identity, stop/exit acknowledgment, offline reconnect, permissions, and cleanup. Choose **one** outcome: supported herdr adapter for this role, or a minimal local PTY daemon with the same app-facing interface. Do not maintain two production runtimes for the demo. An external herdr pane with no app reattachment is not a completed integration.

Provider contract: capabilities, login/availability status, start/resume, send input, normalized events, approval, cancel, result and usage. Session keys include workspace/provider/run/attempt, never a project basename alone. Start by launching installed Claude/Codex interactively with their own login. Structured automation uses the supported interfaces of installed versions; verify them before choosing flags/protocols. Avoid importing CLI credentials into application storage. Gateway becomes an opt-in profile; native mode must not inherit gateway overrides. Keep plugin scope to typed adapters initially, with no arbitrary plugin marketplace prerequisite.

## The intelligent conductor

The existing conductor already does some orchestration in Rust; extend this strength. Do not introduce an LLM manager on every timer tick.

1. **Observe deterministically:** coalesce ticket/dependency/file events; poll only as a bounded reconciliation fallback. Cache repository facts keyed by revision and invalidate affected entries. Idle means zero model calls.
2. **Admit work:** check scope, dependencies, provider availability, project concurrency, user policy, remaining budget and existing lease. Claim atomically. Duplicate source events produce one request/run, not another agent.
3. **Route by policy first:** task kind, changed areas, risk flags, prior failures, estimated context and explicit preference produce a model capability class plus supported effort. Task size and task risk are separate; a one-line auth change can be high risk.
4. **Estimate only uncertainty:** if deterministic classification is ambiguous, make one small structured estimate using a short ticket/facts packet. Luna/Haiku are desired small-model classes only when exposed by the configured provider; resolve actual available IDs. Return complexity, risk, uncertainty and rationale. Cache by ticket/context revision. No recursive debate or guaranteed estimator call per ticket.
5. **Execute with a bounded harness:** launch the appropriate provider in an isolated worktree when needed. Deterministic tools handle git, tests, file selection, dependency checks and artifact capture. Provide targeted files, instructions and relevant failures rather than full logs/history. Serialize conflicting edits/merges; parallelize independent tasks only within capacity and user policy.
6. **Verify and escalate:** require concrete acceptance/test evidence. A process exit or an agent saying done is not ticket completion. Escalate when evidence indicates inadequate capability, not for environment failures. Limit attempts and spend; pause with a useful diagnosis after the bound.
7. **Review and reconcile:** bind approval to run + artifact revision; changed artifacts invalidate stale approval. Track external side effects with idempotency keys and reconcile uncertain outcomes before retry. Release only the lease actually owned by the finished attempt.

Suggested persisted run states: queued → estimating (optional) → running → verifying → needs_review → succeeded; explicit blocked, failed, cancelling, cancelled, and unknown/recovering paths. Persist transitions and ownership before emitting UI events. On reconnect, load a snapshot and replay ordered events; frontend event delivery alone is not durable state.

Expose a concise explanation such as “small model: isolated copy change; escalated after behavioral test failure,” with overrides. Track estimation tokens, worker input/output, latency, retries, verification result and cost where reported. Subscription remaining quota may be unavailable: show unknown and enforce local limits rather than fabricating a percentage. Local Qwen later uses the same capability registry and benchmark suite; validate tool/schema reliability and context capacity before assigning work.

## Delivery sequence and exit gates

These are planning milestone labels, not bd IDs. Create/reconcile implementation issues when bd is working. Ship small complete slices; do not execute this whole plan as one refactor.

| Milestone | Work and dependencies | Exit gate |
| --- | --- | --- |
| M0 — Portable first launch (P0) | Root settings/open-folder, available vs open workspace state, stable IDs/migration, missing-bd/provider empty states, optional gateway/sensors/daily paths. Update README/CLAUDE machine guidance. | Finder launch with absent `~/Code`, valid `~/Desktop/Code`, no key: open one chosen repo; no other tabs/agents spawn. Missing optional tool does not block terminal. Same-name repos remain distinct. |
| M1 — Reliable terminal core (P0, after M0) | Reproduce remount leaks; define attach/detach, ordered replay, byte-safe output, initial resize, backpressure and separate process budgets. Make agent start explicit. Preserve split/layout/theme controls. | Shell PID and marker survive tab/project/collapse/skin/focus transitions; no orphan growth; saturated agent slots still allow bd/git work; Unicode/large output/paste works. |
| M2 — Runtime continuity + native agents (P1, after M1) | Time-box herdr contract evaluation to one session, record go/no-go, implement chosen session owner; provider-neutral lifecycle with native Claude and Codex adapters. | Close/reopen UI reconnects to live shell and active run; daemon restart is honestly reported as restore/recovery. Two providers can run independently; cancel reaches correct worker; no duplicate work on timeout. |
| M3 — Developer daily driver (P1, after M1; continuity gate depends on M2) | Terminal-first shell, workspace rail, palette/shortcuts, Neovim reuse, notifications, coherent themes, optional inspectors. | Complete a real edit/test/git/review session with splits, editor and both agent CLIs without falling back to CMUX for the agreed workflow. |
| M4 — Designer vertical slice (P1, after M2 run contract) | Request capture, ticket-bound execution, preview/artifact evidence, revise/approve, persistent progress, native empty/error/loading states. | Designer requests a small UI change, sees actual preview and checks, requests a revision, approves correct revision, all without terminal knowledge. |
| M5 — Budgeted conductor (P1, after M2; reuse M4 review) | Durable state/leases, deterministic routing, optional estimator, context budgets, bounded escalation, true cancellation, recovery and merge serialization. | Duplicate pulses start one attempt; idle costs zero tokens; failure escalation respects budget; crash reconnect does not duplicate a launch or misreport success. |
| M6 — External pulses (P2, after M4/M5) | GitHub first with source IDs/revisions, drafts, permission boundaries, durable outbox/retries/conflict feedback; Jira follows same contract. | One request round-trips to a chosen external issue/PR with no duplicate post on retry; offline state is visible; review shows exactly what will be sent. |
| M7 — Demo/release gate (after M0–M5; include M6 only when demonstrated) | Packaged native smoke, reproducible sample project, real provider auth, diagnostics, accessibility and measured resource checks. | Complete both demo journeys and documented soak; no mock result presented as real implementation. |

No initial marketplace, multi-machine sync, renderer rewrite, universal connector layer, or local-model install is required. Keep those extensions behind the small contracts above.

## Performance and verification contract

Proposed budgets, **not measured results**: release cold start to usable empty/chosen workspace ≤2 seconds; warm workspace switch p95 ≤100 ms; local key-to-paint p95 ≤50 ms; idle UI + runtime CPU around ≤1% on this Mac. Measure total app/WebContent/runtime process tree and report worker processes separately. Provisional no-agent memory target ≤250 MB; revise with a recorded baseline and explanation rather than declaring victory by excluding child processes.

Use the same project, shell, font, terminal size and Neovim workload in Beads Station and CMUX. Record cold/warm conditions and instrumentation. Run a 30-minute idle/active soak with 20+ workspace, skin, collapse and focus cycles; require no lost sessions, no monotonic PTY/listener growth, and memory returning near the warmed baseline after disposable panes close. Stress large terminal output while interacting with another pane. Add explicit tests for six occupied agent slots, duplicate ticket delivery, provider exit/timeout, missing directories, corrupted persisted layout and stale run events.

Build/unit/mock-browser gates are already defined in AGENTS.md. Add focused Rust protocol/state-machine tests and fake-provider fixtures for lifecycle behavior; preserve meaningful existing tests. Final verification must include actual WKWebView/Finder launch, real login and terminal control. Do not rerun heavy test suites merely for markdown edits or rely on old counts in BEADS-CONTEXT.md.

Developer demo: launch → choose repo → split shell/editor → run tests → start chosen provider on a ticket → switch workspace → return without state loss → inspect diff/checks → close/reopen UI and reconnect. Designer demo: create request with reference → confirm scope → watch progress → preview result → request revision → approve current artifact → show external draft/sync only if implemented.

## Implementation progress — 2026-09-09

Implementation is now authorized and underway on `feat/daily-driver-foundation`. The first slice covers explicit workspace opening, portable settings/auth defaults, and terminal ownership across UI navigation. See [foundation verification](FOUNDATION-VERIFICATION.md) for evidence and remaining work. M0/M1 are not release readiness: the packaged Finder gate, sustained output backpressure/soak, external runtime continuity and provider/designer workflows remain. Earlier review-only statements describe the initial audit.

## Astra resume instructions

Read the foundation verification record first. Finish its outstanding M1 native/soak gates, then take the bounded M2 runtime-contract evaluation; do not recreate the completed workspace picker or UI-lifetime terminal ownership. Read AGENTS.md and this plan; inspect only the source paths needed for the slice. Check worktree status and remote ancestry before branch changes. Do not overwrite the user's package-lock change.

bd is now available with a recovered repository-local database; verify `bd where` and current ticket state before writes. Do not import the passive export into another database. Reconcile existing manual verification tickets `Code-33c`, `Code-efg`, `Code-0vd`, `Code-44k`, `Code-m8x`, `Code-r7q`, and `Code-2a3`. `Code-bqz` is still open in the export although source/history claims fixes; reproduce before reopening work or closing it. Relate new workspace-mode work to `Code-t3j`; fanout/review gaps to `Code-mcj` and `Code-xds`. Avoid recreating already shipped split/theme work.

After each milestone, record the commit, files changed, real checks, unresolved native gates and the next bounded task. Keep the architectural decisions in this plan current and the agent instructions short. This review did not run the app, authenticate providers, benchmark performance, install tools, modify application configuration, or execute tests. Only documentation was added.
