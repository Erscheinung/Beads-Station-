# Sol and Luna implementation prompts

Saved 2026-09-16; none executed. Run one bounded slice at a time. Paste the common
contract plus one prompt, or use the kickoff to let Sol sequence the work. Labels
refer to MASTER-PLAN.md and are not Beads IDs. Each prompt requires the common
contract and the relevant master-plan section; this is part of its acceptance scope.

## Common contract — include with every prompt

> Read AGENTS.md,
> CLAUDE.md, `docs/roadmap-0.2/MASTER-PLAN.md`, and the named slice below. Verify the
> current branch/status; preserve unrelated changes. Before implementation tracker
> writes verify maintainer role and `bd where`, reconcile existing issues, and read
> back writes. Do not edit the JSONL export or Dolt files directly. Do not commit,
> push, publish, install external harnesses, inspect credentials, or run paid providers
> merely to finish this assignment. Fixture checks are the default; native provider
> tests require explicit user test intent. Do not alter the user's Neovim config.
>
> Respect configured model roles. Sol owns the risky runtime/contract slices named
> here; Luna owns bounded UI implementation and its focused validation. No mandatory
> explorer/tester/reviewer pipeline. The orchestrator must not read or diff-review
> worker-authored code; accept the owner's report and route failures back to that
> owner. Keep one writer per file. Complete this slice, then report files changed,
> checks actually run, native evidence separately, remaining uncertainty and the next
> bounded task. Update the implementation issue and handoff truthfully. Hardware
> efficiency, terminal identity, scroll/focus preservation, and zero unintended model
> turns are acceptance requirements. Follow ACCEPTANCE.md for the relevant checks.

## 00 — Sol kickoff and sequencing

> Carry out the master plan incrementally, starting with A1. The baseline was main
> f61430b and released v0.1.0; recheck rather than resetting to it. Establish an
> implementation ledger using existing Beads parents where appropriate. Code-0cp,
> Code-am5, Code-yfb and Code-1dh are historical lookup leads, not assumed open status.
> First reproduce the user's systemic bottom clipping, cursor loss and scroll jumps
> with sanitized native fixtures. Do not start a Designer redesign or Svelte migration.
> Give Luna complete ownership of independent small slices only after their contracts
> are clear. Keep A1/A2/A3/A6 terminal ownership sequential. Deliver the first verified
> patch slice before expanding. Track A3 persistence and B1 orchestration together so
> there is one runtime/run owner. Plan the 0.1.x Developer workstream and 0.2.0 Designer
> release separately, with no published tag changes until explicitly requested.

## 01 — Sol: terminal clipping, focus and scroll (A1)

> Diagnose and fix the user-reported terminal truncation after workspace/fullscreen
> switches, lost cursor/focus, and scroll jumping toward the top when returning. Own
> the relevant terminal session/attach/geometry code, pane state and any demonstrated
> shared chat-anchor cause. Start with terminalSessions.ts, Terminal.tsx,
> TerminalPanes.tsx, termPanes.ts, ClaudeChat.tsx and pty.rs. The screenshots show
> symptoms, not a known cause. Record visible bounds, rows/cols, PTY dimensions,
> viewport anchor, buffer type, active input target and PID before/after. Reproduce
> with normal shell and alternate-screen fixtures before using existing agent sessions.
> Fix only demonstrated lifecycle errors; preserve follow-output versus reading-history
> behavior. Test resize, font/scale changes, hidden output, 20+ navigation cycles,
> fullscreen/zoom, modal focus, IME and Neovim input. Run focused existing unit/browser
> checks and a freshly packaged native smoke. No periodic repaint/fit polling, forced
> bottom scroll, or session recreation. Report the causal evidence and remaining gates.

## 02 — Sol: close guard and no-turn restore (A2)

> Implement one coherent close/quit intent policy across Cmd+W, close button, Cmd+Q
> and native menus, in dev and packaged builds. Own native window lifecycle and the
> frontend session preference/restore boundary. Cancel must leave terminal focus,
> drafts and PIDs intact. Explain active work and stop only scoped owned processes
> when the user chooses to stop. Add Keep running only when A3 capability is verified.
> Restore saved workspace/layout/context automatically under a persisted preference.
> Preserve observed provider session IDs; prove restore sends no new turn with fake
> Claude/Codex adapters. Do not inject continue or replay shell history. Distinguish
> restored screen, idle resumed session and attached live process. Test duplicate close
> events, corrupted state, stale IDs, active work, no sessions and OS-forced termination
> recovery. This slice cannot claim live persistence until A3 passes.

## 03 — Sol: durable owner selection and implementation (A3)

> Read RESEARCH.md's Herdr experiment and inspect the existing herdr_bridge.rs and
> pty.rs boundaries. Pin and evaluate supported transport in an isolated environment;
> obtain any necessary external installation authority before installing a runtime.
> Prove raw replay/stream/input/resize/alternate-screen/cancel and native GUI reattach.
> Choose Herdr only if it passes; otherwise record a no-go and implement one minimal
> app-owned background owner with the same boundary. Do not create competing PTY
> owners or migrate by socket-file existence. Own executable discovery, handshake,
> identity, local socket permissions, startup/shutdown, version mismatch, bounded
> buffers and recovery. Coordinate the contract with B1. Test GUI quit/crash/reopen,
> daemon stop/restart, stale PID, lost acknowledgment and duplicate clients. The same
> live PIDs must survive GUI closure; daemon restart must be labeled reconstruction.
> Use shells and fake providers for lifecycle tests. Preserve no-new-turn restoration.

## 04 — Luna: lightweight workspace finder and Browse (A4)

> Own WorkspacePicker.tsx/CSS/tests and only the necessary project-discovery boundary.
> Implement the master plan's one main combobox with cached fuzzy matching and native
> Browse directory button. Empty query shows recent explicit opens; matching shows
> canonical paths and keyboard selection. Replace the duplicate lower search with
> Known projects / Under folder scope. Scope indexing must be bounded, cancellable,
> ignore-aware and off the UI thread; typing must not rescan roots or open anything.
> Respect missing roots, symlink cycles, paths with spaces/Unicode/tilde and duplicate
> project names. A DMG cannot depend on fzf/rg being installed. Test selection/Enter,
> Browse cancel/open, stale query results, recency ranking and a large directory fixture.
> Include native directory-picker evidence and a warm-search latency observation.

## 05 — Luna: initialize Beads from empty project (A5)

> Own board/explorer empty-state actions and the narrow backend init wrapper. First
> inspect installed bd help/version; choose supported initialization for new projects
> and bootstrap for tracked exports. Add a named command and rebindable shortcut entry.
> Distinguish absent database from missing executable, bad permissions or corruption.
> Show target folder and effects, initialize only that canonical workspace on intent,
> prevent duplicate clicks, verify the resulting store and refresh the board. Never
> overwrite or initialize a neighboring project. Test fresh folder, existing database,
> export-only clone, missing bd, failure and rapid workspace switching. Use disposable
> projects; do not initialize the maintainer checkout anew.

## 06 — Luna: reorder, fullscreen navigation and spatial focus (A6)

> After A1 is complete, own TabBar, TerminalPanes, order state and relevant command/
> shortcut UI. Add pointer and keyboard reorder for workspace/terminal tabs, with
> stable IDs, persisted order and accessible announcements. Add next/previous/direct
> selection and reorder commands without colliding with existing bindings. Follow
> the proposed defaults and conflict policy in MASTER-PLAN.md. Preserve current pane
> focus/resize bindings, leader and editor input. Navigation must work in native
> fullscreen, full-canvas terminal mode and zoom. Preserve per-workspace selected pane
> and ratios; split from fullscreen must reveal the new layout. Borrow spatial focus
> ideas from the pinned Omarchy source and local cmux; copy no implementation assets.
> Test asymmetric splits, boundary focus, drag versus close/click, IME, Neovim, reduced
> motion and stable PIDs/screen/anchors through repeated reorder/switch cycles. Avoid
> terminal refit per animation frame.

## 07 — Luna with Sol contract: named interaction recipes (A7)

> First have Sol define typed recipe execution/authorization/cancellation boundaries.
> Luna then owns recorder, editor, naming, shortcut binding and settings integration.
> Record semantic app commands only during explicit recording, with editable arguments
> and context targets. Support stop/cancel, rename, duplicate, delete, reorder steps,
> import/export, bounded replay and undo of configuration edits. Terminal keystrokes,
> passwords and clipboard contents must not be captured. Advanced terminal command
> steps are separately reviewed actions. Reuse the shared command registry and config
> schema rather than installing a second keyboard handler. Test disabled-recorder
> overhead, missing targets, recursion, invalid imports, cancellation, scope changes,
> conflicts and restart persistence. Demonstrate “Review workspace” in a disposable
> workspace without any provider launch.

## 08 — Sol: shared orchestration ledger (B1)

> Own conductor.rs, shared run service and persistence contract; reconcile existing
> nativeRuns/Claude/Codex state rather than adding another scheduler. Implement durable
> request/attempt/config identity, admission idempotency, fencing, attempt-owned merge
> slots, atomic transitions and ordered replay. Manual Start must work with pulses
> disabled. Replace ambiguous success/unknown and bead-only ownership. Preserve exact
> cancellation/reap/drain semantics and hold ownership until confirmed terminal state.
> Test duplicate manual/pulse delivery, two windows, crash before/after spawn, lost
> handle, stale snapshots, lease expiry with live child, PID reuse, cancelled output,
> budget exhaustion and unrelated workspace isolation with fake providers. Do not let
> an agent prompt alone enforce merge exclusivity. Record the schema migration and
> failure-recovery contract before handing UI work to Luna.

## 09 — Sol backend then Luna UI: harness profiles (B2)

> Implement the master-plan manifest/capability contract and immutable per-attempt
> configuration. First support native Claude/Codex, then import the local adaptive
> instruction profile without executing its installer or overwriting global config.
> Add a bounded mixed profile with explicit stage ownership and one experimental
> custom adapter fixture. Do not import Clodex's mandatory review or automatic PR
> behavior. Model IDs/effort resolve from supported provider configuration; display
> requested and observed values truthfully. After the backend is ready, delegate
> Settings presets/import/test/configure and Designer selector to Luna. Test malformed
> manifests, unavailable binaries/models, unsafe arguments, unsupported resume/cancel,
> hooks that attempt unintended continuation, config edits mid-run and fake mixed
> routing. Every selectable supported harness must pass ACCEPTANCE.md conformance.

## 10 — Sol contract then Luna UI: complete Designer (B3)

> Complete a real request-to-approved-artifact journey using the B1/B2 services.
> Sol owns immutable artifact capture, safe preview boundary, validation evidence,
> and transactionally exact run/revision approval. Luna owns the Designer surface
> wiring after that contract is stable: requests, draft/reference fields, progress,
> profile choice, previews, revision feedback, approvals and recoverable errors.
> Audit every visible control against the inventory in MASTER-PLAN.md. Keep Beads
> human gate resolution distinct from artifact approval. Remove fabricated states,
> silent failures and misleading tier labels. Use static local game fixtures first;
> test stale approval, changed artifact hash, symlinks, oversized/unsafe content,
> workspace switch during actions, cancel/reload, and double approval. The Designer
> must complete request/revise/approve without a terminal. Do not mark complete until
> the packaged native journey works; explicit provider tests are a separate gate.

## 11 — Sol backend then Luna UI: editable MCP/settings (B4)

> Implement versioned app config transactions, scopes and secret references, MCP
> stdio/Streamable HTTP configuration, and transport-appropriate auth. Own migrations,
> validation, rollback, stale revision rejection and Finder binary discovery. No
> secrets in prompts/exports/logs and no implicit global CLI config writes. Delegate
> simple Connections/Agents/Advanced forms and prompt-proposal diff/apply UI to Luna
> after the schema is stable. Prompt edits must produce validated patches; manual
> forms must work without a model. Test invalid JSON, workspace trust boundaries,
> concurrent file/UI edits, redaction, disconnect/revoke/expired auth, changed schemas,
> missing runtimes and nondeveloper DMG setup. Begin with fixture servers; real service
> account tests are explicit user actions, not automatic implementation side effects.

## 12 — Sol scheduler then Luna UI: optional pulses (B5)

> Connect normalized intake to B1 with pulses Off as the default. Implement Scan now,
> persisted source cursors/mappings, dedupe, backoff, quiet hours and pause controls.
> Deterministic rules can fully replace AI triage. Optional configured Luna/Haiku
> triage gets bounded changed-item context and no duplicate calls for unchanged
> revisions. Expose cadence/query/tool/destination/ingest-only or authorized auto-run
> settings through Luna's UI after the scheduler contract is stable. Test manual
> requests with no connections, unchanged scans with zero model calls, duplicate
> pagination/webhook events, offline/restart/sleep-wake, source edits, rate limits,
> expired auth, malicious request instructions and budget exhaustion. Generic MCP
> fixtures are required; GitHub first, Figma/Jira mappings only from verified schemas.
> Do not send external messages or auto-run requests based on intake alone.

## 13 — Sol: packaged release candidate (B6)

> Execute ACCEPTANCE.md on the exact candidate build. Reconcile historical test
> tickets and record observed versus missing evidence. Run every supported harness's
> fixture contract and explicit user-authorized native profile journeys; an untested
> imported profile stays experimental. Test upgrade from v0.1.0 on a disposable
> profile, config migration/rollback, GUI persistence, no-turn restore and performance
> soak. Prepare release notes/checksums/screenshots/install/upgrade/signing/architecture
> information and synchronized version metadata. Do not reuse screenshots from an
> earlier build, move v0.1.0, or publish without a publication request. A Designer mock
> or blocked approval journey is not a release-ready 0.2.0.

## 14 — Sol in the internal environment: work auth / work-tools

> This is a future integration spike. The user named work-auth-mcp and internal
> work-tools for Jira, GitHub and Teams. Their tools and auth are not available in
> the planning context. Discover exposed documentation and schemas here; do not
> guess tool names or endpoints. Let the user complete the supported authentication
> flow, never inspect/copy credentials. Document verified transport, tenant/account
> scope, read capabilities, pagination/cursors, refresh/revocation and runtime needs.
> Adapt them to B4/B5 without duplicating intake or auth storage. Start with a selected
> read-only request and redacted fixtures. A message/post/issue update requires a
> separately explicit target/content instruction. Report what can ship publicly,
> what requires internal setup, and a DMG-friendly onboarding procedure. Do not claim
> this extension is required or verified for the base 0.2.0 release.

## 15 — Sol assessment only: Svelte feasibility and learning

> Assess Code-1dh after terminal lifecycle behavior has a measured baseline. Read
> current official React/Svelte/Tauri documentation during the assessment. Do not
> migrate production or change dependencies as part of an assessment. Inventory
> React-specific hooks/context, xterm ownership, DnD/virtualization, theme/settings,
> IPC subscriptions, testing and build tooling. Compare staying on React with targeted
> fixes, a small Svelte island, and a full rewrite. Estimate effort, regression risk,
> library replacements, coexistence cost and learning value. Propose a separately
> authorized disposable spike using the same dataset and interactions, measuring
> bundle/startup/CPU/memory/input latency rather than promising framework speedups.
> Provide go/no-go criteria and rollback steps. Explain stores/runes, lifecycle and
> cleanup, component composition, effects and testing through equivalents familiar
> from this app. Include a short learning exercise and a paired React/Svelte example
> in documentation if useful. Deliver an evidence-based assessment markdown file,
> with unknowns explicit; no migration is a prerequisite for 0.2.0.
