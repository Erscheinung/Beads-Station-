# Beads Station — agent handoff

## Start here

**Latest handoff — 2026-09-10:** User stopped expansion with 8% usage remaining.
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
