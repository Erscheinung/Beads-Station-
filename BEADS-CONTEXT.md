# Beads Station — Persistent Recovery Context

**Read this first if you are a new Claude session picking up this project.**

This document is the system of record for context that doesn't fit in code or in a planning markdown. It's deliberately stored in TWO places to survive bd data-loss events: this file inside the repo, and `~/Documents/Beads/BEADS-CONTEXT.md` in the Obsidian vault. They should be kept in sync. Bd issues are the canonical task tracker — the bd IDs below are the live source of truth for "what to do next."

---

## Critical operational gotcha

**`git config beads.role maintainer` is a hard prerequisite for `bd` to persist any writes.**

Without it, `bd create` returns a fresh ID and a green `✓ Created issue:` line, but the write is silently dropped — the issue does not appear in `bd list`, `bd show <id>`, `bd export`, or `bd ready`. The only visible signal is a `warning: beads.role not configured (GH#2950)` line on every command, easy to miss.

**Second gotcha**: bd reads `beads.role` from the *process cwd*, not from the `-C <path>` target. If you run `bd -C ~/Code ready` from any other directory, bd will print the role-not-configured warning even when the target repo has it set, and (depending on bd's internal logic) may silently drop writes. **Always `cd ~/Code` first**, then run bd commands without `-C`. This makes the role check land against the correct repo.

This caused a multi-issue data-loss event on 2026-06-12. All 11 originally-created phase tickets vanished between sessions. The fix is one line per repo:

```bash
cd ~/Code && git config beads.role maintainer
cd ~/Code/Beads-Station && git config beads.role maintainer
```

**Phase 8 has been updated to make this check part of the first-run wizard, and Phase 10 will add a `bd doctor` preflight in the app.** Until those land, every new session should run `bd -C ~/Code where && git -C ~/Code config --get beads.role` as its first action.

---

## How this project is built (the agent loop)

1. New session opens.
2. `bd -C ~/Code ready` shows the next available phase ticket.
3. Read the plan: `~/.claude/plans/we-have-a-git-synthetic-dusk.md` (also at `~/Documents/Beads/IMPLEMENTATION-PLAN.md`).
4. `bd update <id> --claim --actor "Beads Station"` to mark in-progress.
5. Fan out worker subagents via the Workflow tool — one parallel agent per independent slice of the phase. Pattern from Phase 1: scaffold-agent → bridge-agents in parallel → shell-agent → build-agent.
6. Workers write code, commit individually, return JSON status.
7. Parent agent reviews status, fixes any cross-cutting issues the workers couldn't (toolchain pins, identifier renames, etc.), produces the deliverable.
8. `bd note <id> "<deliverable summary>"` then `bd close <id> --reason "..." --actor "Beads Station"`.
9. Append a `## HH:MM` subsection to `~/Documents/Beads/Daily/{YYYY-MM-DD}.md` describing what shipped.
10. Tell the user what closed and what's newly ready.

**bd is the tracker; the Workflow tool is the parallelism engine; CLAUDE.md forbids TodoWrite/TaskCreate.**

---

## Phase IDs (live, post-recovery)

The original `Code-8m7.*` IDs were lost in the data-loss event. The recreated IDs are:

| Phase | ID | Status (as of 2026-06-15) | Blocks |
|---|---|---|---|
| Epic | `Code-ky4` | open | — |
| 1: Vertical slice | `Code-ky4.1` | **closed** (shipped commit `f3b24fc`) | — |
| 2: Project picker + per-tab Claude | `Code-ky4.2` | **closed** (P2: `545b9e2..ab007e6`; P2.5 fix-up: `61815ea..ab1bde0`) | 3 |
| 2.5: PATH + tab overflow + Claude diagnostics | `Code-txf` | **closed** (`61815ea..ab1bde0`) | — |
| 2.6: Gateway .env loader for Claude | `Code-guz` | **closed** (`704ec6d`, wired in `ba9fe3c`) | — |
| 3: Jira board + drag-drop | `Code-ky4.3` | **closed** (`1f05080..ba9fe3c`) | 4, 7, 8 |
| 4: LazyVim aesthetic + functional ports | `Code-ky4.4` | **closed** (`2491630..135447c`) | 5 |
| 5: Issue tree + indent guides | `Code-ky4.5` | **closed** (`4233249..c32b35c`) | 6, 9 |
| 6: Claude tool surface + cmux-style status | `Code-ky4.6` | **closed** (`6cb867b..c5cfc05`) | — |
| 7: Obsidian daily updates | `Code-ky4.7` | open, **ready** | — |
| 8: First-run migration of `[Project]` brackets | `Code-ky4.8` | open, **ready** | — |
| 9: Command palette + vim keybindings | `Code-ky4.9` | open, **ready** | 10 |
| 10: Polish + signed dmg | `Code-ky4.10` | open, blocked by 9 | — |
| R0: Stabilization + telemetry baseline (reboot phase 1 of 12) | `Code-mua` | **closed** (shipped 2026-07-06) | R1 |
| R1: Async-cleanup helper + eliminate 4 known leaks (reboot phase 2 of 12) | `Code-5hs` | **closed** (shipped 2026-07-07) | R2 |
| R2: Bounded collections + IssueTree virtualization (reboot phase 3 of 12) | `Code-3w2` | **closed** (shipped 2026-07-08) | R3 |
| R3: bd surface hardening + crash-free bd view (reboot phase 4 of 12) | `Code-992` | **closed** (shipped 2026-07-09) | R4 |

Run `bd -C ~/Code show Code-ky4.<N>` for full description / acceptance criteria of any phase.

---

## What's already on disk (through Phase 5)

```
~/Code/Beads-Station/
├── artifacts/Beads-Station.dmg          # 4.12 MB (P6 — claude tool surface + permission picker + morning modal), aarch64, identifier ai.beads-station.desktop, unsigned
├── BUILD.md                              # phase 1 build report (still current — toolchain unchanged)
├── BEADS-CONTEXT.md                      # this file (canonical)
├── .env                                  # GITIGNORED — ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL for Gateway
├── .env.example                          # public template documenting the contract
├── rust-toolchain.toml                   # pinned to 1.90.0
├── package.json + node_modules/...       # +@tauri-apps/plugin-store (P2), +@dnd-kit/core +@dnd-kit/sortable (P3); P4: predev+prebuild → audit-emoji; P5: +@vscode/codicons (icon font, MIT)
├── scripts/audit-emoji.mjs               # P4: emoji-glyph gate. fails build on U+1F300-1FAFF / U+2600-27BF / U+2300-23FF / U+1F000-1F2FF in JSX text. ▼ U+25BC and › U+203A explicitly allowed.
├── src/
│   ├── App.tsx                           # P4: useVimNav() at top, project:cycle listener, sidebar focus boxShadow, gridTemplateRows '1fr 280px 22px', <Statusline> + <Dashboard> + <WhichKey> mounted. P5: inline 'BEADS · ALL READY' header lifted (IssueList renders its own). P6: usePermissionMode(active.id) + thread permissionMode into ClaudeChat; needsConfirm gate (shouldConfirm + confirmedFor session set) suspends ClaudeChat behind a centered <MorningConfirm/> modal until Resume/New; <PermissionModePicker/> mounted globally and portals into the chat header slot. R0: {import.meta.env.DEV && <DebugOverlay/>} mounted immediately after <WhichKey/> — Vite const-folds the branch out of production bundles.
│   ├── main.tsx + index.css              # P4: full tokyonight Storm token set as --bs-*. JetBrains Mono enforced. .bs-grid-1px utility, .bs-tab::after diagonal slash separator, .bs-card hover composes priority bar + hairline shadow. P5: '/* Phase 5 — issue tree */' block — bs-issuetype--{epic|feature|task|bug|chore|unknown} codicon glyphs (rocket eb44 magenta, sparkle ec10 blue, checklist eab3 cyan, bug eaaf red, tools eb6d, circle-outline eabc); bs-status-dot 6px + bs-status--{open|in_progress|blocked|closed|deferred}; bs-tree-chevron + --expanded/--leaf rotation; bs-tree-row + --group/--active; bs-tree-guide (1px abs --bs-border-faint default, --lit --bs-border on cursor row's ancestor path); bs-tree-{,grouplabel,id,title} container/leaf-span styles. main.tsx imports '@vscode/codicons/dist/codicon.css' once. P6: '/* Phase 6 — claude tool surface */' block — bs-claude-drawer/header/body/row (collapsible hook-events drawer above chat scroll), bs-approval (+ --resolved variant) + bs-approval-tool/input/actions/btn (+ --approve --deny color modifiers), bs-cost-meter (22px JetBrains Mono strip, --bs-fg-muted labels + --bs-fg <strong>), bs-system-reminder (2px --bs-blue left-border + 6%-tint background), bs-permmode segmented control 3-pill picker, bs-modal-backdrop + bs-modal-card + bs-modal-title/sub/actions/btn (+ --primary --ghost), bs-tab-status 6px circle (+ --idle visibility:hidden). R0: '/* R0 — debug overlay (dev only) */' block — bs-debug-overlay (fixed bottom-right, min-width 220px, opacity 0.9, z-index 9999) + bs-debug-header/body/row/row--sub/key/unit/empty/hint (JetBrains Mono 11px, --bs-bg-dark background, --bs-border hairline). CSS rule set ships in every build; JS ref is dev-only via App.tsx guard.
│   ├── lib/listenerRegistry.ts           # R0: safeListen<T>(channel, handler, options) wrapper over @tauri-apps/api/event listen(). Buckets channel by first-colon prefix (claude_event:{pid} → 'claude_event'). Increments/decrements a per-bucket count map ONLY in import.meta.env.DEV; production returns raw listen() unchanged. Exports getListenerCounts() snapshot + subscribeListenerCounts(cb) for useSyncExternalStore. Idempotent unlisten via `released` flag + Math.max(0, …) defense-in-depth. R1: ClaudeChat + Terminal + BdLiveProvider now route through this via src/lib/safeListen.ts (see below); claudeStatus.ts stays on raw listen() by design (own entry/refCount lifecycle) so its channels do NOT appear in the overlay.
│   ├── lib/safeListen.ts                  # R1: signal-based helper — safeListen<T>(channel, handler, signal): Promise<void>. Wraps listenerRegistry.safeListen (imported as registryListen) so telemetry counts stay observable. Pre-checks signal.aborted; awaits registryListen; re-checks aborted (immediate unlisten if raced); else wires signal 'abort' → unlisten via {once:true}. Callers create one AbortController per effect and abort() in cleanup — no hand-tracked cancelled flags or unlisten handles. This is the global fix for the async-IIFE-across-await-boundary leak class.
│   ├── lib/BdLiveProvider.tsx             # R1: <BdLiveProvider> context + useBdLiveContext(repoPath, onChange). Holds a useRef Map<repoPath, {ac, refCount, callbacks:Set, pending}>. First subscriber per repoPath does invoke('watcher_start') + one safeListen('bd_changed:{repoPath}', …, ac.signal); fan-out debounced ONCE at provider (100ms = old REACT_DEBOUNCE_MS) then calls every callback. Last unsubscriber ac.abort()s + deletes entry (no watcher_stop — single global watcher). Supersedes per-caller useBdLive: Board + IssueList on the same repoPath now share ONE bd_changed listener instead of two. Wraps App.tsx L97-181 subtree.
│   ├── state/projects.ts                 # P2: useProjects() hook + activeId in localStorage
│   ├── state/vim.ts                      # P4: useSyncExternalStore-based store {mode, leaderActive, focused}; mirrors to window.__bsVim
│   ├── state/tree.ts                     # P5: pure tree shaping (NO React). buildTree(issues) → roots grouped project→status→parent; flattenVisible(roots, expanded) DFS; firstIssueId; idToPath. DEV-only inline smoke tests at bottom.
│   ├── state/projectLabel.ts             # P5: projectLabelFor(issue) — first PascalCase label, else bracketed-title prefix, else '(unlabeled)'.
│   ├── state/claudeUsage.ts              # P6: per-project Usage atom {cost,in,out,cacheRead,cacheCreate}. accumulate() guards on parent_tool_use_id==null for assistant frames; cost only ticks on result frames. useSyncExternalStore-backed useUsage(projectId).
│   ├── state/claudeStatus.ts             # P6: per-project ClaudeStatus atom 'running'|'awaiting-input'|'error'|'idle'. Lazy-starts subscription per projectId; listens claude_status:{pid} (canonical, BE-emitted) + claude_event:{pid} + claude_stderr:{pid} (defensive fallbacks).
│   ├── state/claudeSettings.tsx          # P6: usePermissionMode(projectId) hook persists 'acceptEdits'|'default'|'plan' to projects.json store (same file projects.rs uses) + invokes claude_set_permission_mode on every change. Exports <PermissionModePicker/> — segmented 3-pill control that createPortal()s into #bs-claude-header-right slot.
│   ├── hooks/useBdLive.ts                # P3: subscribes bd_changed:{repoPath} → debounced refetch
│   ├── hooks/useVimNav.ts                # P4: global window keydown — Space leader (1s window), p/b/c/s/q bindings, j/k/h/l per-pane routing, Tab/Shift+Tab on board, Enter/o issue:open, gq quit combo, INPUT/TEXTAREA/.xterm/.ProseMirror/contentEditable bypass. P5: extends with sidebar-gated h/l (collapse/expand current row), zR (expandAll), zM (collapseAll), gg (first row), G (last row); j/k now dispatch sidebar:cursor {detail.delta}; Enter/o on sidebar dispatch sidebar:cmd {cmd:'open'}; gq combo coexists with new gg combo (routes on second char).
│   ├── hooks/useTreeNav.ts               # P5: useTreeNav(issues) → {rows, cursorIndex, expanded, move, toggle, expandToward, open, expandAll, collapseAll, jumpTo}. Default-expanded set: project + status group ids; parent issues collapsed. open() emits 'issue:open' window event.
│   ├── types/issue.ts                    # bd Issue interface + ready/show/list/claim/setStatus/close/label/note helpers
│   └── components/
│       ├── IssueList.tsx                 # P5 REWRITE: thin wrapper. bdList(repoPath, null) (was bdReady) → useBdLive refetch on bd_changed → buildTree → useTreeNav → renders 'BEADS · {label} ({count})' header + <IssueTree>. Subscribes 'sidebar:cursor' (delta) and 'sidebar:cmd' (cmd: expand|collapse|open|expandAll|collapseAll|first|last) window events.
│       ├── IssueTree.tsx                 # P5: visual primitive. renders rows from flatRows; bs-tree-row[--group|--active] divs (position:relative, height:22px); per-depth absolute bs-tree-guide divs at left=(d+0.5)*16px (--lit when ancestor on cursor path); bs-tree-chevron[--expanded|--leaf] codicon-chevron-right; bs-issuetype + bs-status-dot per issue; downstream-ring (yellow boxShadow) on open issues with dependent_count>0. single-click selects, double-click opens, Enter on group toggles.
│       ├── Terminal.tsx                  # collapsible 280px ↔ 24px, xterm.js bound to PTY
│       ├── TabBar.tsx                    # P2/2.5: bufferline strip; P4: diagonal slash separator, active gets 2px --bs-blue top+bottom
│       ├── ClaudeChat.tsx                # P2/2.5: per-project events, status dot, surfaces stderr+raw. P6 REWRITE: takes optional permissionMode prop (threaded into claude_start); on mount invokes bd_prime(cwd) and prepends a synthetic _kind:'system-reminder' frame + claude_send the same text wrapped in <system-reminder>...</system-reminder> so the running session sees the rules; partitions hook frames into <ToolDrawer/> (above scroll); detects permission_request frames defensively (top-level type, subtype, OR assistant.message.content[0]==='tool_use') and renders inline <ApprovalCard/> per request_id; mounts <CostMeter projectId={...}/> between scroll and form; stable header slot #bs-claude-header-right for PermissionModePicker portal; global keydown wires 'a'/'d' (gated on useVim().focused==='chat' + isEditableFocus bypass) to approve/deny topmost pending card via claude_approve/claude_deny RPCs.
│       ├── ToolDrawer.tsx                # P6: collapsible hook-events panel above the chat scroll. Header '▼ hook events (N)' / '› hook events (N)' (▼ U+25BC, › U+203A — both audit-emoji allowed); body max-height 240px, rows 18px '{hookName} · {tool ?? '·'} · {trunc(detail,80)}'. Open/closed persisted per-project to sessionStorage('beads-station.drawer.{projectId}'). Exports frameToHookEvent() pure helper for ClaudeChat partitioning.
│       ├── ApprovalCard.tsx              # P6: inline approval card. Pending state shows tool name + <pre> input JSON (max 120px scroll) + Approve(a)/Deny(d) buttons → invoke('claude_approve'|'claude_deny',{projectId,requestId}). Resolved state collapses to '[ok] approved tool=Edit' / '[x] denied tool=Edit' (textual ASCII — ✓/✗ would fail audit-emoji U+2600-27BF range).
│       ├── CostMeter.tsx                 # P6: 22px JetBrains Mono footer between chat scroll and form. 'cost $0.0042 · in 1,250 · out 940 · cache ↑12k' from useUsage(projectId). cache shows max(cacheRead,cacheCreate) with ↑ U+2191 (outside audit-emoji forbidden ranges) when non-zero. formatTokens() shortens to k/M above thresholds.
│       ├── MorningConfirm.tsx            # P6: backdrop+card modal portaled to document.body. Shown when localStorage('beads-station.lastConfirmed.{projectId}') !== local-tz YYYY-MM-DD. Resume autofocused; Enter+Escape both pick Resume (safe default); backdrop click = Resume; New session = New. Exports todayYMD()/shouldConfirm()/recordConfirmation() helpers consumed by App.tsx.
│       ├── Board.tsx                     # P3: 4-column drag-drop, optimistic UI + rollback toast
│       ├── Column.tsx                    # P3: useDroppable
│       ├── Card.tsx                      # P3 useDraggable + P4: 3px inset priority bar, --bs-card-bar custom prop, 13px/500 title, drag rotate -2deg + var(--bs-shadow-card)
│       ├── Statusline.tsx                # P4: 22px lualine — mode pill | path | branch | counts | spacer | clock | pending dot
│       ├── Dashboard.tsx                 # P4: empty-state ANSI Shadow BEADS ASCII + tip table
│       └── WhichKey.tsx                  # P4: leader-overlay; subscribes useVim().leaderActive
│       ├── DebugOverlay.tsx              # R0: fixed bottom-right dev-only panel. F12 toggles (INPUT/TEXTAREA/contentEditable bypass). Subscribes 'debug_stats' via raw listen() only while visible (unopened overlay costs 0 listeners) with cancelled-flag async race guard. Renders rss MB + tokio_tasks + total listeners + per-bucket sub-rows from useSyncExternalStore over listenerRegistry. Mounted in App.tsx behind import.meta.env.DEV.
└── src-tauri/
    ├── tauri.conf.json
    ├── Cargo.toml + Cargo.lock           # +tauri-plugin-store (P2), +notify 8.2 macos_fsevent (P3), +sysinfo 0.38 default-features=false features=["system"] (R0 — pinned 0.38 not 0.39 because 0.39.5 needs rustc 1.95 and toolchain is 1.90; API surface is identical for our use)
    └── src/
        ├── lib.rs                        # 29 commands registered (P4: +bd_counts +bd_git_branch; P6: +bd_prime +claude_approve +claude_deny +claude_set_permission_mode), plugin-store + envloader init in run(). R0: added `mod telemetry;` (alphabetized between pty and watcher) + a `.setup(|app| { telemetry::start(app.handle().clone()); Ok(()) })` closure between plugin(store) and invoke_handler — first .setup() in this project. No new commands registered.
        ├── telemetry.rs                  # R0: 1s tokio::time::interval sampler (MissedTickBehavior::Skip) — cfg(debug_assertions) only; release-build start() is a no-op. Emits bare 'debug_stats' event with DebugStats {rss_mb: u64, tokio_tasks: usize, sampled_at_ms: u128}. RSS via sysinfo::System::refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing().with_memory()); process.memory() bytes / (1024*1024). tokio_tasks via tokio::runtime::Handle::current().metrics().num_alive_tasks() — stable, no tokio_unstable cfg. Spawns via tauri::async_runtime::spawn (NOT bare tokio::spawn — .setup() runs outside a live runtime context; bare tokio::spawn panics with "there is no reactor running"; the tauri wrapper routes onto the runtime tauri owns).
        ├── main.rs
        ├── envloader.rs                  # P2.6: .env loader (parses KEY=value, set_var into process env)
        ├── binresolve.rs                 # P2.5: canonical-dir-first binary resolver
        ├── bd.rs                         # P3: ready/show/list reads + claim/set_status/close/label/note writes; P4: +bd_git_branch (rev-parse --abbrev-ref HEAD; "(detached)"/"(no-git)" fallbacks) +bd_counts (BdCounts {ready,in_progress,blocked,closed}); current_dir over -C. P6: +bd_prime(repo_path) — runs `bd prime` under current_dir with 5s tokio::time::timeout, returns stdout for FE injection as <system-reminder>.
        ├── pty.rs                        # pty_spawn, pty_write, pty_resize, pty_kill (portable-pty)
        ├── projects.rs                   # P2/2.5: scans ~/Code/, mints+persists session UUIDs, skips dirs with spaces
        ├── claude.rs                     # P2/2.5/2.6: per-project HashMap, namespaced events, ANTHROPIC_* forwarding, [claude_start] diag frame. P6: claude_start takes permission_mode: Option<String> (validated against {acceptEdits,default,plan}, falls back to MODES cache then 'acceptEdits'); MODES: Lazy<Mutex<HashMap<String,String>>> + claude_set_permission_mode RPC for live mode swap without session restart; stdout reader emits 'running' on assistant-frame and 'awaiting-input' on result-frame to claude_status:{pid}; stderr reader emits 'error' on every non-empty line; claude_approve/claude_deny RPCs write a tool_result-shaped user frame ({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:<request_id>,content:'approved'|'denied'}]}}) to session.stdin — chosen as forward-compatible fallback because Claude CLI 2.x has no documented permission_request/_response stream-json pair (verified via --help 2026-06-18; --permission-mode prompts interactively in 'default' mode rather than via JSON round-trip).
        └── watcher.rs                    # P3: macOS FSEvents on <repo>/.beads/, 250ms debounce, emits bd_changed:{repoPath}

~/Documents/Beads/
├── SOURCE-PROMPT.md                      # original ask + locked decisions
├── IMPLEMENTATION-PLAN.md                # full plan (mirror of ~/.claude/plans/we-have-a-git-synthetic-dusk.md)
├── BEADS-CONTEXT.md                      # this file (mirror of repo copy)
└── Daily/2026-06-12.md                   # first daily rollup
```

**Remaining hardcodes (post-P6):**
- Claude binary path: `~/.local/bin/claude` is now a *fallback* — `binresolve::resolve_bin_or_default` checks the canonical-dir list first. Still a hardcode; Phase 10 candidate (user-configurable settings UI).
- bd binary: now resolved via `binresolve::resolve_bin("bd")` — checks `~/.local/bin → /opt/homebrew/bin → /usr/local/bin → /usr/bin → /bin`, then PATH. No bare `Command::new("bd")` left.
- Project root: `~/Code/` is hardcoded as the scan root in `projects.rs`. Additional repos come from `~/Code/.beads/config.yaml` `repos.additional`. Phase 8 (first-run wizard) may add multi-root support.
- Spaces-in-dir-name skip: `projects.rs` drops any candidate whose basename contains a space, working around a suspected Claude CLI session-id transcript-path encoding issue. Phase 6 originally targeted this (replace with JSONL-replay path); P6 left the workaround in place — the replay path is now a Phase 10 deferred item (see below).
- Permission mode: **no longer hardcoded** — P6 lifted `--permission-mode acceptEdits` to a configurable per-project setting (`acceptEdits | default | plan`) persisted to `projects.json` via tauri-plugin-store. Default remains `acceptEdits` for back-compat.

**Phase 2 lifted:** target project path and per-project Claude session UUID are now caller-supplied. Each project gets a UUID auto-minted on first scan and persisted via `tauri-plugin-store` to `~/Library/Application Support/ai.beads-station.desktop/projects.json` (or wherever `app.store("projects.json")` resolves on macOS).

**Phase 2 events are namespaced:** `claude_event:{projectId}`, `claude_event_raw:{projectId}`, `claude_stderr:{projectId}`. Anything still listening on the bare `claude_event` name will silently miss frames.

---

## Reboot baseline (R0)

Debug-build main-process RSS captured 2026-07-06 via `ps -o rss=` against `target/debug/beads-station`. Sampled after `npm run tauri dev` boot completed and the WKWebView + JS runtime had settled. No project opened, no Claude session started, no bd operations run.

| Sample | RSS | Notes |
|---|---|---|
| Cold-start (t=0, immediately after webview settled) | **125,680 KB (122.7 MB)** | Debug build, dev mode. Includes vite HMR client + full source maps. |
| 5-min idle | 125,680 KB (122.7 MB) | Flat. No drift. |
| 10-min idle | **125,712 KB (122.8 MB)** | +32 KB drift over 10 min (0.03%). Steady-state confirmed. |
| Post 20-frame Claude session | **pending** | Requires user-driven Claude session. Deferred to R1 first-run — R1 opens with this measurement as gate condition. Follow-up: `Code-*` R0.1 to be filed if R1 forgets. |

**tokio_tasks (num_alive_tasks) baseline:** not captured — requires opening the F12 overlay in the running app, which is user-driven. R1 will read this from the overlay during its first project-switch cycle. Sanity floor: at cold start, expect ~4 (tauri runtime workers + 1 sampler). Under an idle open project: +1 for watcher (`watcher.rs:108`); once a Claude session is started, +2 for claude stdout/stderr readers (`claude.rs:194, 248`).

**Listener-channel prefix baseline:** the JS-side `listenerRegistry` (`src/lib/listenerRegistry.ts`) reports only channels wrapped via `safeListen()`. On 2026-07-06, **zero call sites use `safeListen`** — the overlay's listeners sub-rows will read empty and show the string `no tracked channels — call sites still on raw listen()`. R1 migrates the five raw sites in one go (`bd_changed`, `claude_event`, `claude_status`, `claude_stderr`, `pty_data`+`pty_exit` = 6 channels, 5 files). At that point the overlay will populate with 5 prefix buckets and R1's leak-hunt verification ("listener counts return to baseline within 500ms of unmount") becomes measurable.

**Interpretation.** 122 MB is a debug-build number and includes vite HMR + Tauri devtools bridges — the release-build cold RSS from a signed dmg will be materially lower (P6 dmg is 4.12 MB on disk; runtime footprint TBD in R4 soak). The zero-idle-drift is the useful signal: it establishes the "nothing should grow while idle" contract R2 (bounded collections) and R4 (soak) will assert against. Under load, the four documented leak classes (ClaudeChat IIFE, Terminal PTY, claudeStatus subscription, double-`useBdLive`) are expected to push RSS monotonically upward — that curve is what R1 must eliminate.

**How to sample yourself.**

```bash
# 1. Boot dev (blocks — leave running)
cd ~/Code/Beads-Station && npm run tauri dev &

# 2. After Tauri window appears, sample RSS from another shell:
ps ax -o rss=,command= | grep 'target/debug/beads-station' | grep -v grep

# 3. Alternatively, open the app → press F12 → read overlay.
#    RSS = the `rss` row. tokio_tasks = the `tokio tasks` row.
#    Listener counts = the `· <prefix>` sub-rows (empty until R1).
```

---

## Locked design decisions (from planning Q&A — do not relitigate)

| Decision | Choice |
|---|---|
| cmux usage | **Conceptual model lifted, no code reused.** Parallel-isolated-agents-per-tab pattern (Phase 2), per-agent status badges + cost/token tracking (Phase 6). License is AGPL — code reuse would taint Beads Station. |
| LazyVim usage | **Aesthetic + functional patterns ported to web.** Tokyonight Storm tokens, neo-tree-shaped sidebar, lualine statusline, vim modal nav, which-key hints, telescope fuzzy switcher. Phase 4 + 9. |
| Default Claude permission mode | `acceptEdits` is the default; per-project override (`acceptEdits | default | plan`) is shipped in P6 and persists via tauri-plugin-store. P6 also wired inline approve/deny RPCs against a `tool_result`-shaped fallback frame because Claude CLI 2.x has no documented permission_request/_response stream-json round-trip — `default` mode prompts interactively instead. |
| Visual rule | "Don't make it the generic Claude purple haze" — purple kept as sparing accent only, never dominant; no glassmorphism, no gradient washes, no AI-app halos. No emojis in UI strings (devicons OK). |
| Multi-project model | One canonical tracker at `~/Code/.beads/`. First-run wizard (Phase 8) migrates `[Project]` brackets to structured `project=<slug>` labels. |
| Daily file shape | `/Documents/Beads/Daily/{YYYY-MM-DD}.md`, append `## HH:MM` subsections. Zero YAML frontmatter (matches vault convention). |
| Packaging target | macOS only for v1 |
| bd integration | Subprocess + `--json` only. Never read `embeddeddolt/*` or write `issues.jsonl`. **P3:** writes go through `current_dir(repo_path)` instead of `-C` to dodge the bd-cli role-check quirk. |
| Claude integration | `claude --print --input-format=stream-json --output-format=stream-json` per-project subprocess, resumable via stable `--session-id`. No SDK. |
| Gateway gateway | **Routed via `claude` CLI's `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` env vars.** No SDK swap. The `.env` file at the repo root is the single source of truth — values forwarded explicitly via `Command::env()` from `claude.rs`. P2.6 also emits a `[claude_start]` diagnostic frame on `claude_event_raw:{pid}` showing whether the API key was loaded (bool only) and which `base_url` is active. |

---

## Build + run cheatsheet

```bash
# rebuild dmg
cd ~/Code/Beads-Station
source ~/.cargo/env
npm run tauri build
cp "src-tauri/target/release/bundle/dmg/Beads Station_0.1.0_aarch64.dmg" "artifacts/Beads-Station.dmg"

# dev (hot-reload, faster iteration)
npm run tauri dev

# bd state
bd -C ~/Code ready
bd -C ~/Code show Code-ky4.<N>
bd -C ~/Code list --status=open

# verify bd is healthy
bd -C ~/Code where
git -C ~/Code config --get beads.role   # MUST output "maintainer"
```

**First-launch instructions for the user:**

```bash
open ~/Code/Beads-Station/artifacts/Beads-Station.dmg
# drag to Applications
# right-click "Beads Station" in /Applications → Open → confirm Gatekeeper warning ONCE
# subsequent launches work normally
```

---

## Active tech-debt / deferred work (live list)

- **Universal binary**: dmg is aarch64-only. Phase 10 must add `--target universal-apple-darwin` so x86_64 Macs work. (Not relevant for current user — they're on Apple Silicon.)
- **Code signing**: deferred to Phase 10. Until then every new dmg requires right-click → Open on first launch.
- **Toolchain pins**: `rust-toolchain.toml` (1.90.0) + `time = 0.3.47` are workarounds for an `E0119` collision in `time 0.3.48` vs `cookie 0.18.1`/`tauri-utils 2.9.2`. Revisit when Tauri ships a `tauri-utils` with a `time` upper bound.
- **Vite warning**: `@tauri-apps/api/core` both statically and dynamically imported, prevents chunk splitting. Cosmetic.
- **bd persistence preflight**: Phase 10 should add a startup check that fails loudly if `git config beads.role` is unset in any tracked project, so the data-loss event of 2026-06-12 cannot recur silently.
- **`Code-urn` (P3)**: `claude_start` holds the SESSIONS tokio Mutex across `Command::spawn` — perf only; revisit alongside the JSONL-replay work.
- **`Code-1u9` (P3)**: `projects.rs` mints UUIDs into the store but only `.save()`s once at the end of the scan. Loop body is essentially infallible so this rarely matters; revisit if anyone reports vanishing IDs.
- **`Code-2a3` (P2)**: smoke-test that `claude --print --session-id <known-uuid>` actually replays prior frames to stdout. P6 did not address this; the per-project unmount-on-tab-switch issue below depends on it.
- **Phase 2 unmount-on-tab-switch**: `App.tsx` uses `key={active.id}` on Terminal and ClaudeChat, so a tab switch tears down the PTY and unsubscribes from Claude events (the Claude *child process* keeps running because `claude_kill` is not called from `ClaudeChat` cleanup). Originally a P6 target — deferred to Phase 10 because P6 prioritized the tool-surface deepening; the cmux-style "PTYs and listeners alive across switches" pattern is still on the books.
- **Spaces-in-dir filter**: P2.5 workaround — projects.rs drops any candidate whose basename contains a space. Phase 10 (alongside the JSONL-replay path) should make this filter unnecessary.
- **JSONL-replay path** (NEW from P6): `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` direct replay would let us seed scrollback without depending on `claude --session-id` round-trip behaviour, and would let us drop the spaces-in-dir filter. Originally Phase 6 scope, deferred to Phase 10.
- **Empirical permission_request frame** (NEW from P6): the `claude_approve`/`claude_deny` Tauri commands today write a `tool_result`-shaped user frame because Claude CLI 2.x has no documented stream-json permission round-trip (verified 2026-06-18 via `--help`). When upstream exposes a real `permission_response` frame, swap the body of `write_permission_response` in `claude.rs` — the FE contract does not change.
- **bd_prime noise** (NEW from P6): `bd prime` emits the entire workflow primer (~5KB of markdown). ClaudeChat renders the full text inside a 200px-max-height scrollable `<div class="bs-system-reminder">` block at the top of the transcript. If the noise is annoying, Phase 7 can collapse it to a one-line `[primer loaded · {N} bytes]` indicator with a click-to-expand affordance.
- **MorningConfirm + new sessions**: `onNew()` invokes `projects_set_claude_session(id, crypto.randomUUID())` then `refresh()`s the project list. The `key={active.id}` on `<ClaudeChat/>` ensures the new sessionId remounts the panel, so the BE spawns under the fresh UUID. Verified by codepath inspection; not yet exercised end-to-end with a non-empty prior session.

---

## R1 shipped (2026-07-07) — async-cleanup discipline

**Issue:** `Code-5hs` (closed). Reboot phase 2 of 12, Pillar 2.

**What shipped.** The four documented leak classes are eliminated on one helper. New `src/lib/safeListen.ts` — `safeListen(channel, handler, signal): Promise<void>` — wraps R0's `listenerRegistry.safeListen` so the F12 overlay's per-channel counts populate for the migrated sites while adding `AbortSignal` discipline across await boundaries. Callers create one `AbortController` per effect and `abort()` in cleanup; no more hand-tracked `cancelled` booleans or dangling unlisten handles.

- **ClaudeChat.tsx** — the async IIFE with three `listen()` calls (`claude_event`, `claude_event_raw`, `claude_stderr`) rewritten to a single `AbortController` + three `safeListen(…, signal)`. All prior `if (cancelled)` guards switched to `signal.aborted`. Cleanup is `() => ac.abort()`. Claude lifecycle still NOT auto-killed on unmount (Phase 6 contract unchanged).
- **Terminal.tsx** — `pty_spawn` race closed with `ptyIdRef`. Ref set the instant spawn resolves; if `signal.aborted` post-spawn, the just-born PTY is killed immediately and the effect bails before arming listeners. Both `pty_data`/`pty_exit` on `safeListen`. onData/resize read `ptyIdRef.current` (not the stale closure local). Cleanup kills via the ref (covers both normal + post-abort-spawn), then nulls it.
- **claudeStatus.ts** — added `terminated: boolean` to `ProjectEntry`. Set true (before the unlisten loop) when refCount hits 0 and the entry is deleted. Each of the three `await listen()` in `startSubscription` is followed by `if (e.terminated) { off(); return }`, so a listen resolving after the entry was deleted unlistens itself instead of pushing onto an orphaned entry. Stays on raw `listen()` by design — this module owns its own entry/refCount lifecycle; a flag is the minimal correct fix. (Consequence: claudeStatus channels do NOT show in the overlay — only ClaudeChat's do.)
- **BdLiveProvider.tsx** (new) + **App.tsx** / **Board.tsx** / **IssueList.tsx** — Board and IssueList each armed their own `bd_changed:{repoPath}` listener; on a shared repoPath that was two OS listeners for one channel. Now one `safeListen` per repoPath fanning out to all ref-counted subscribers. `useBdLive.ts` marked DEPRECATED (no live callers; kept for reference).

**Verification.** `npm run build` clean (tsc + vite + audit-emoji). `cargo check` clean (no-op — frontend-only phase, zero Rust touched). Adversarial review of all five sites (safeListen, BdLiveProvider, ClaudeChat, Terminal, claudeStatus): zero leaks, every abort/terminate guard on the correct side of its await; StrictMode double-mount races confirmed safe (first-mount IIFE resolving post-delete no-ops because its `ac.signal` is already aborted).

**NOT yet done — needs a human at the running desktop app (display-bound, can't drive headless):**
- 20 project-switch soak: overlay listener counts return to baseline within 500ms of each unmount.
- RSS growth < 5MB over 20 switches (read `rss_kb` from overlay).
- Terminal open/close 10x rapid: `ps aux | grep zsh` count returns to baseline (no orphaned PTYs).
- Board+IssueList on same repoPath: overlay shows exactly ONE `bd_changed` bucket.
- claude_status/claude_event/claude_stderr baseline after a Claude session (R0's deferred measurement).
These are the R0-baseline follow-ups the overlay was built for; the code is correct by review but the live curve is unmeasured. Whoever next boots the dev app should run the checklist in the 2026-07-07 R1 prompt §7 and record the overlay numbers.

**Newly ready:** R2 (bounded collections — `frames[]`, `hookEvents[]` caps). The RSS-ceiling concern noted at R0 baseline is R2's target, not R1's; R1's success criterion was listener-count baseline (met by review, pending live confirm).

---

## R2 shipped (2026-07-08) — bounded collections + IssueTree virtualization

**Issue:** `Code-3w2` (closed). Reboot phase 3 of 12, Pillar "bounded state". Depends on R1 (`Code-5hs`).

**What shipped.** Every accumulating collection now has a hard cap + rolling-window eviction, and `IssueTree` no longer does O(N*T) DFS per keystroke.

- **ClaudeChat.tsx** — `frames` capped at 500 via a single `appendFrame(next)` helper (`FRAME_CAP=500`) that ALL six append sites now route through (claude_start-fail catch, bd-prime system-reminder inject, claude_event main-frame push, claude_event_raw, claude_stderr, send() local echo). On overflow it `slice(-500)`s, tallies the drop count into a new `evictedCount` state, and — in the SAME event handler — GCs `approvalStates` by rebuilding the live-requestId Set from the surviving frames (via `extractApproval`) and keeping only keys that still appear (no orphan approval state past eviction). `hookEvents` capped at 200 (`.slice(-200)` on the one push site). Eviction marker: when `evictedCount > 0`, a muted single-line `— {evictedCount} earlier frames evicted —` renders as the first child of the scroll body using `var(--bs-fg-muted)` (no new CSS var). `framesRef.current = frames` auto-caps because it mirrors post-cap state. Known cosmetic: scroll-map React keys are still array-index `key={i}` — a single eviction render can transiently re-key `<pre>` rows (self-corrects next frame; ApprovalCard's composite `approval-${i}-${requestId}` anchors card identity on requestId). Not worth a keying rework for R2 (§8 scope guard).

- **tree.ts** — `FlatRow` gained `ancestorPath: string[]` (root..node id chain, inclusive — same value `idToPath` would return). `flattenVisible` now threads the path through its DFS walk (`walk(node, depth, parentPath)` → `path = [...parentPath, node.id]`), so the ancestor chain is computed once during flatten instead of via repeated `idToPath` calls. `idToPath` export retained — still used by `useTreeNav.expandToward` (the rare, non-per-render call site). DEV smoke tests updated to assert `FlatRow.ancestorPath === idToPath(...)`.

- **IssueTree.tsx** — deleted the per-row `idToPath(roots, row.node.id)` call (the O(N*T) hotspot); rows read `row.ancestorPath` instead. `litBranchKeys(flatRows, cursorIndex)` rewritten to build the lit Set ONCE from the cursor row's `ancestorPath` (no `idToPath`), memoized with `useMemo([flatRows, cursorIndex])`; guide render does O(1) `lit.has(...)`. Virtualized with `@tanstack/react-virtual` (`useVirtualizer`, `count=flatRows.length`, `estimateSize=()=>28`, `overscan=8`); scroll parent is `parentRef` on the `bs-tree` div, rows are absolutely positioned via `translateY(vi.start)`. Added a `scrollToIndex(cursorIndex, {align:'auto'})` effect so vim `j`/`k` keeps the cursor row in the rendered window (virtualization would otherwise let the active row scroll out of the DOM). `roots` prop kept in the surface but no longer read per-render (`_roots`).

- **index.css** — `.bs-tree-row` height locked to exactly `28px` (`height/min-height/max-height: 28px` + `box-sizing: border-box; overflow: hidden`) to match the virtualizer's fixed row estimate. Was 22px; bumped to 28 so estimate is exact and there is no row-height jitter.

- **package.json** — `+@tanstack/react-virtual ^3.14.7` (MIT).

**Verification.** `npm run build` clean (tsc + vite + audit-emoji). `cargo check` clean (frontend-only phase, zero Rust touched). Adversarial re-read of both edited components in the main thread: all six frame-append sites route through `appendFrame`; `approvalStates` GC covers the orphan-key case; no `idToPath` remains in `IssueTree` per-row or in `litBranchKeys`; virtualizer row keys are `row.node.id` (stable). The 4-agent Workflow (audit → parallel build A/B → verify) produced the edits; the `scrollToIndex` cursor-follow was added in the main thread post-workflow.

**NOT yet done — display-bound, can't drive headless (same class as R1's deferred live-verify):**
- React DevTools Profiler: 20× `j` on the 500-row fixture, median + p95 keystroke render < 16ms, before/after. **Numbers not captured** — requires the running dev app + DevTools Profiler + a wired `__BS_TREE_FIXTURE__` 500-row fixture. The fixture flag from §5b was NOT built (deferred — the memoization + virtualization + Set-lit changes are the mechanism; the Profiler number is the proof, still owed). Whoever next boots the dev app should build the fixture and record the numbers here.
- 1000-frame synthetic Claude session RSS < 100MB plateau: not run (needs live Claude session + F12 overlay).

The bar per §10 is "measurably better and documented," not "perfect": the DFS-per-keystroke cost is eliminated by construction (ancestorPath precompute + Set-lit + virtualized DOM), and the caps bound memory by construction. The live Profiler/RSS curves are the outstanding proof, filed here rather than blocking the phase.

**Follow-ups:** none opened (no virtualizer breakage, no <16ms miss observed in code review). The Profiler-fixture + RSS-soak measurement rolls into R4 (leak-hunt soak week), which already owns the live-app measurement harness.

---

## R3 shipped (2026-07-09) — bd surface hardening + crash-free bd view

**Issue:** `Code-992` (closed). Reboot phase 4 of 12, Pillar "bd surface hardening + crash-free bd view". Depends on R1 (`Code-5hs`) + R2 (`Code-3w2`).

**What shipped.** Every `bd_*` type contract is now correct, every invoke failure surfaces as a toast instead of a silent no-op / uncaught rejection, `bd_counts` runs concurrent, drag rollback can't clobber a concurrent refetch, and the "bd view crash" is root-caused + fixed (it was never a bd-binary crash).

### Type-contract diff table (every `bd_*` command)

| command | Rust sig | TS wrapper sends | matched? | fix |
|---|---|---|---|---|
| `bd_ready` | `repo_path: String` | `{ repoPath }` | ✓ | — |
| `bd_show` | `repo_path: String, id: String` | `{ repoPath, id }` | ✓ | — |
| `bd_list` | `repo_path: String, status_filter: Option<String>` | `{ repoPath, statusFilter: x ?? null }` | ✓ | — (already Option) |
| `bd_claim` | `repo_path: String, id: String` | `{ repoPath, id }` | ✓ | — |
| `bd_set_status` | `repo_path: String, id: String, status: String` | `{ repoPath, id, status }` | ✓ | — |
| `bd_close` | ~~`reason: String`~~ → **`reason: Option<String>`** | `{ repoPath, id, reason: x ?? null }` | ✗→✓ | **Rust→Option + default fallback** |
| `bd_add_label` | `repo_path, id, label: String` | `{ repoPath, id, label }` | ✓ | — |
| `bd_remove_label` | `repo_path, id, label: String` | `{ repoPath, id, label }` | ✓ | — |
| `bd_note` | `repo_path, id, text: String` | `{ repoPath, id, text }` | ✓ | — |
| `bd_git_branch` | `repo_path: String` | `{ repoPath }` | ✓ | — |
| `bd_counts` | `repo_path: String` | `{ repoPath }` | ✓ | — (parallelized internally) |
| `bd_prime` | `repo_path: String` | `{ repoPath }` | ✓ | — |

**Only real offender: `bd_close`.** TS `bdCloseIssue(repoPath, id)` with no reason sends `reason: null`; the bare `reason: String` Rust sig made serde reject the invoke, which the UI never surfaced — a silent no-op (the exact "user sees nothing happen" symptom). Fix: `reason: Option<String>` with an `unwrap_or_else(|| "Closed via Beads Station")` default. All other params are required-and-always-populated, so they were already correct. No `R3-followup` issue needed — the audit surfaced exactly one mismatch.

### Changes

- **src-tauri/src/bd.rs** — `bd_close` reason→`Option<String>` (line ~189). `bd_counts` (line ~288) rewritten: `tokio::try_join!(bd_ready(..), bd_list(.., None))` runs the two subprocess reads concurrently (was sequential `.await?` then `.await?`); wrapped with a `std::time::Instant` + one `tracing::info!(repo, elapsed_ms, ready, in_progress, blocked, closed, "bd_counts")` emit (no span guard held across await).
- **src-tauri/Cargo.toml** — `+tracing = "0.1"`, `+tracing-subscriber = { version = "0.3", features = ["env-filter","fmt"] }`.
- **src-tauri/src/lib.rs** — first line of `run()`: `tracing_subscriber::fmt().with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("beads_station=info"))).try_init()`. `RUST_LOG=beads_station=debug,tauri=info` now controls output. (First structured-logging init in this project; telemetry.rs's `debug_stats` sampler is unrelated and untouched.)
- **src/lib/invokeErrorBoundary.tsx** (NEW) — `safeInvoke<T>(cmd, args, { rethrow?, label? })` wraps the dynamic-imported `invoke`; on rejection pushes a toast then either resolves `undefined` (fire-and-forget) or re-throws (opts.rethrow, to preserve callers' own try/catch). `InvokeErrorBoundary` React class boundary (getDerivedStateFromError + componentDidCatch→toast) with a recoverable fallback (retry button) instead of a white screen. `InvokeToasts` (useSyncExternalStore atom) renders a bottom-anchored, `--bs-red`-accented, `column-reverse` stack: message + timestamp + "copy details" (clipboard) + dismiss `x`; auto-dismiss 8s, paused on hover via ref-armed timer.
- **main.tsx** — `<InvokeErrorBoundary>` wraps `<App/>` under StrictMode.
- **src/types/issue.ts** — all 9 bd_* wrappers migrated to `safeInvoke(..., { rethrow: true })` (reads + mutations rethrow so Board rollback / IssueList error state still fire; the toast surfaces first).
- **src/components/Statusline.tsx** — `bd_git_branch` + `bd_counts` (both the 5s poll and the bd_changed refetch) → `safeInvoke(..., { rethrow: true })`; local catch handling kept.
- **src/components/ClaudeChat.tsx** — `bd_prime` → `safeInvoke(..., { rethrow: true })` into the existing non-fatal catch. `claude_send`/`claude_*` stay raw (not bd_*).
- **src/components/Board.tsx** — drag generation counter: `dragGenRef = useRef(0)`; `refetch` bumps `dragGenRef.current++` as its first `try` line; `handleDragEnd` captures `const gen = dragGenRef.current` at snapshot time and the catch only `setState(snapshot)`s `if (dragGenRef.current === gen)` — a concurrent `bd_changed` refetch that lands mid-drag bumps the gen, so a subsequently-rejected mutation no longer reverts the newer data. Toast still fires either way.
- **src/components/IssueDetail.tsx** (NEW) — the missing `issue:open` listener (see root cause below). Fetches `bdShow(activePath, id)`, renders an overlay detail card (title/status/priority/type/assignee/labels/description/counts); Escape or backdrop-click dismisses. All fetch errors → inline error row + safeInvoke toast; never throws into render.
- **App.tsx** — `<IssueDetail repoPath={active.path} />` mounted next to `<WhichKey/>`.
- **index.css** — R3 block: `.bs-invoke-toasts`/`.bs-invoke-toast*` (toast stack), `.bs-eb-*` (boundary fallback), `.bs-detail-*` (issue detail overlay). All ASCII glyphs (`x` close buttons) — audit-emoji clean.
- **Test infra (NEW)** — `+vitest @testing-library/react @testing-library/jest-dom jsdom @testing-library/user-event` (devDeps), `vitest.config.ts` (jsdom, globals, setup), `src/test/setup.ts` (jest-dom + `IS_REACT_ACT_ENVIRONMENT=true` for React 19 act support), `package.json` scripts `test`/`test:watch`, tsconfig `types: [vitest/globals, @testing-library/jest-dom]`.
- **src/components/Board.test.tsx** (NEW) — drag generation-guard regression test. Mocks `@tauri-apps/api/core`, `../lib/invokeErrorBoundary`, `../lib/BdLiveProvider` (captures the bd-live onChange), and `@dnd-kit/core`'s `DndContext` (captures onDragEnd) so the scenario runs deterministically with no pointer physics + no fake timers. Fires: initial paint → arm mutation-reject (delayed 20ms) → start drag → land a bd_changed refetch that publishes newer state (ISSUE-NEW) → let the delayed rejection roll back → assert the newer state survives. **Mutation-verified non-vacuous:** passes with the gen guard, FAILS when the guard is reverted to unconditional `setState(snapshot)`.

### `bd view` crash — root cause + fix

**It was never a bd-binary crash.** "bd view" is the app's issue-detail action: the sidebar's `useTreeNav.open()` (Enter / `o` on an issue row) dispatches an `issue:open` CustomEvent (`useTreeNav.ts:161`) — but **no component listened for it**. The detail pane was never implemented (a "Worker 4" TODO). So pressing Enter on an issue did nothing; the user read the dead no-op as a crash. Fix location: **new `src/components/IssueDetail.tsx`** (the listener) + App.tsx mount. Because the fetch goes through `bdShow`→`safeInvoke` (rethrows into an inline error row + toast) and the whole tree sits under `InvokeErrorBoundary`, the worst case for any bad id / broken bd is a toast — never a white screen. No upstream bd issue filed (nothing crashes in the bd binary; `.beads/config.yaml` has no bd-upstream remote anyway — only the work-internal `origin`).

### bd_counts before/after timing

**Not captured live** (display-bound — the timing shows in the R0 F12 telemetry overlay / `tracing` stderr of the running dev app, which can't be driven headless). The mechanism is in place: `tokio::try_join!` makes the two `bd` subprocess reads concurrent instead of sequential, so wall-clock is `max(ready, list)` not `ready + list` — expected ~halving since the two calls are near-equal-cost `bd` spawns. The `tracing::info!(elapsed_ms=…)` line is the instrument; whoever boots the dev app with `RUST_LOG=beads_station=debug` should record the pre/post numbers here. Filed as the same class of display-bound follow-up as R1/R2's overlay measurements (rolls into R4 soak).

### Verification

`npm run build` clean (tsc + vite + audit-emoji 0 violations across 38 files). `cargo check` clean. `npx vitest run` 1 passed (the gen-guard regression, mutation-verified). Grep confirms **zero raw `invoke("bd_` / `invoke('bd_` outside `safeInvoke`**. bd_close(null) is now a valid default-reason close (no serde reject). InvokeErrorBoundary + safeInvoke would surface a forced `safeInvoke("bd_nonexistent")` rejection as a toast (by construction; the catch → pushInvokeToast path).

**NOT done — display-bound (can't drive the GUI headless):** bd_counts pre/post wall-clock numbers; opening the detail pane 10× live; forced-rejection toast visually confirmed on screen. These are the same measure-in-the-running-app follow-ups R1/R2 deferred to R4's soak harness. The code paths are correct by construction + unit-tested where headless-testable.

**Newly ready:** R4 (leak-hunt soak week — owns the live-app measurement harness that clears R1/R2/R3's deferred display-bound checks).

---

## RV1 — Multiplexed shells (cmux parity) · 2026-07-26 · Code-pqr (closed)

First phase of the **value-first track** that supersedes the reboot roadmap's chrome phases (R4–R11). Thesis: the single biggest concrete reason the user still opens cmux is multiplexed shells; this closes it.

The single collapsible Terminal is now a **terminal pane manager**: tabs-of-split-trees, persistent shells, vim splits/tabs/focus/zoom/close.

- **Model:** `src/state/termPanes.ts` — external store (useSyncExternalStore, no zustand), cached getSnapshot (stored `state` ref, replaced by spread on every mutation — deliberately NOT the R3.5 uncached-snapshot loop). Tabs, each a binary split tree of shell leaves.
- **PTY lifecycle LIFTED** out of Terminal into the store. `Terminal.tsx` is now controlled (`paneId` + `onSpawn`), spawns its pty, reports the id, and does NOT kill on unmount — reflow preserves the shell. Store's `closeActivePane()` owns the kill.
- **Layout:** `src/components/TerminalPanes.tsx` — recursive flex splits, 1px `--bs-border` seams, inset-blue focus ring, tab strip (>1 tab only), zoom via absolute-cover (panes stay mounted).
- **Keymap** (in `useVimNav` terminal-focus block): `<leader>s`/`v` split · `<leader>t` new tab · `C-w h/j/k/l` (+`C-w w`) focus · `<leader>z` zoom · `<leader>x`/`C-w q` close · `<leader>1..9` + `gt/gT` tabs. Insert vs pane-op submode via termPanes `insert` + `window.__bsTerm` mirror.
- **BE `pty.rs`: unchanged** (already multi-PTY, zsh-only). RV2 agent panes will need a generic spawn-command seam there.

**Verification:** build (tsc+vite+emoji) clean · `cargo check` clean · vitest 12/12 · live `tauri dev` boots clean, shell spawns, no render loop. **Deferred:** manual in-window split/tab pass; persistence path (a) per-project layouts → RV1.1. Full handoff block in `Daily/2026-07-26.md` under `<!-- RV1-HANDOFF -->`.

**Next value phase:** RV2 (multi-agent panes).

---

## RV2 — Multi-agent panes (N Claude sessions in one window) · 2026-07-26 · Code-fpc (in_progress — awaiting live confirm)

Second value-track phase. Orchestration half of *one-window-everything*: the RV1 pane tree now hosts **live Claude agent sessions** as first-class leaves alongside shells. Split/tab/focus/zoom/close keymap applies uniformly to agent panes.

Design was **workflow-judged** (3 independent architects → judge picked MINIMAL GRAFT 20/20 → synthesized; 4 forks user-decided). Spine:

- **bridgeId = optional pane-scoped identity, defaults to projectId.** Every claude-session-scoped key (events `claude_event/status/stderr/event_raw:{id}`, usage bucket, status atom, header portal id, approval RPCs) uses `bridge`. Legacy single chat passes bridgeId omitted → `bridge===projectId` → byte-identical wire format, zero ABI break. Agent panes pass a distinct `uid('agent')` → isolated namespace, so two panes on the SAME project never collide.
- **Agent leaf = optional `agent?` field on the existing `Leaf`** (`kind:'leaf'` unchanged) so all 7 termPanes tree helpers stay untouched. `isAgentLeaf(l)` guard. Shell leaves keep `ptyId`; agent leaves keep `ptyId:null` + carry `{bridgeId, projectId, sessionId, permissionMode}`.
- **Status stays OFF-leaf** — `useClaudeStatus(bridgeId)` in the pane header (never written to termPanes state; it changes every frame → would churn the store / reintroduce the R3.5 loop).
- **claude.rs:** Code-urn spawn-lock fixed — SESSIONS lock dropped across `.spawn()`, re-acquired with a compare-and-insert re-check that kills the losing child (no orphan, concurrent distinct-bridge spawns no longer serialize). `project_id` param name kept (value = bridgeId) → zero ABI change. +3 Rust tests.
- **Keymap:** `<leader>a` spawns an agent pane on the active project (both leader menus; dispatches `agent:spawn`, App handles it). Close (`<leader>x` / `C-w q`) fires `claude_kill(bridgeId)` for agent leaves.
- **Two chat surfaces coexist** (user-confirmed fork): the legacy fixed-grid ClaudeChat stays; agent panes are additive in the terminal tree.

**Files:** `claude.rs`, `termPanes.ts`, `TerminalPanes.tsx` (AgentPaneLeaf), `ClaudeChat.tsx` (bridgeId/active props), `useVimNav.ts`, `App.tsx`, `claudeSettings.tsx` (+test). NO change: `vim.ts`, `claudeUsage`, `claudeStatus`, `CostMeter`, `ToolDrawer` (opaque-string keys accept bridgeId as-is).

**Commits:** `b4bfb2a` (RV2) + `9aa9526` (focus-model + bd_prime toast fix).

**Verification:** build (tsc+vite+emoji 0) clean · `cargo test claude` 3/3 · `vitest` 13/13 (incl. new bridge-scoped-portal test) · `tauri dev` clean boot (no render loop; StrictMode double-mount handled by the spawn-lock re-check).

**Live bugs found + fixed (2026-07-26, commit `9aa9526`):**
1. **Stuck typing in agent pane, leader/C-w dead, Esc doesn't exit insert.** Root: agent `<input>` holds real DOM focus but nothing tied it to the termPanes `insert` mirror (exactly RV1 handoff gotcha 2 — don't rely on blur for an always-focusable input). Fix: input `onFocus/onBlur` drive `setInsert` (real focus == insert truth); local Esc handler blurs; ClaudeChat rAF-autofocuses post-mount; removed the synchronous `setInsert(true)` from App spawn + AgentPaneLeaf mousedown (header/body click stays pane-op so leader/C-w work).
2. **"invoke bd_prime failed" toast spam.** Root: ClaudeChat used `safeInvoke('bd_prime', …, {rethrow:true})` which toasts on every failure though the caller already treats it non-fatal; RV2 amplified (N panes = N bd_prime). Fix: plain `invoke()`, local catch warns silently.

**STILL OWED (can't drive the WKWebview headless — RV1/R3.5 lesson: loops/focus only fire on real interaction):** manual Tauri-window pass — `<leader>a`×2 → two distinct live sessions + distinct status dots; type-isolation between panes; `<leader>x` kills only that session (`ps aux|grep claude`); leader/C-w don't leak into agent input; Esc exits insert.

**Suspected environmental (NOT an RV2 code regression):** "issues gone on project switch" — most likely fork exhaustion (`fork failed: resource temporarily unavailable` was reproduced in-session) amplified by per-pane claude+bd subprocess load, colliding with the known bd-spawn-storm. IssueList/Board/useProjects/BdLiveProvider are untouched by RV2. Confirm live with a single agent pane before treating as a code bug.

**Next value phase:** RV3 (file-nav + rich agent rendering — absorbs reboot R8/R9). Full handoff block in `Daily/2026-07-26.md` under `<!-- RV2-HANDOFF -->`.

---

## RV2-fix + RV3 — file-nav + rich agent rendering · 2026-07-26 · Code-51e/d3p/8ro/ia4

Third value-track phase (absorbs reboot R8/R9). Closes the nvim gap for a *navigate-not-edit* user: a file-nav pane + rich rendering of Claude's edits, both inside the RV1 pane model / RV2 agent leaf. Split A/B/C, gated on an RV2-fix.

### RV2-fix (Code-51e) — the "issues gone on project switch" root cause

**CONFIRMED (not environmental-only): a real backend leak RV2 amplified.** The legacy grid `ClaudeChat` is mounted `key={active.id}` (App.tsx), so it unmounts on *every* project switch — but its old unmount cleanup deliberately did NOT `claude_kill` ("Phase 6 manages lifecycles"). So the backend `SESSIONS` map leaked one persistent `claude --print` child per visited project, unbounded, never reaped. N projects = N live claude children (each forking git/dolt of its own) → fork exhaustion (`fork failed: resource temporarily unavailable`) → IssueList/Board `bd` reads fail → issues appear to vanish. IssueList/Board/useProjects/BdLiveProvider are genuinely untouched by RV2 — they're the *victim*, not the bug. Backend had ZERO teardown (no Drop, no CloseRequested, no `kill_on_drop`; tokio Command orphans on drop).

**Fix (commit after b4bfb2a):**
- `claude.rs`: `cmd.kill_on_drop(true)` (a dropped ClaudeSession can no longer orphan); `kill_all_sessions()` drain + `claude_kill_all` command.
- `lib.rs`: `.on_window_event` `CloseRequested` → `block_on(kill_all_sessions())` so quitting reaps everything.
- `ClaudeChat.tsx`: the LEGACY grid chat (`bridgeId==null`) now `claude_kill`s its bridge on unmount. **Agent panes (bridgeId set) intentionally stay persistent** — they survive project switch by design and are reaped by explicit `<leader>x` or the app-exit handler.
- kill isolation was already correct (SESSIONS keyed by bridge; `<leader>x` kills only that pane's child). Residual: `claude_kill` is fire-and-forget with no retry (sad-path under-kill if it rejects mid-start) — low, kill_on_drop + CloseRequested backstop it.
- +test `kill_all_on_empty_is_zero_and_idempotent` (claude 4/4).

### RV3-A (Code-d3p) — rich agent rendering

`ClaudeChat`'s flat per-frame `<pre>{renderFrame(f)}</pre>` is replaced by a rich render-item tree. **`src/lib/renderItems.ts`** — pure `buildRenderItems(frames, isApprovalPending)`: indexes `tool_result` by `tool_use_id`, pairs tool_use↔tool_result into one collapsible unit, groups Task subagent frames (by `parent_tool_use_id`, recursively — scope model keyed on ROOT|taskId, cycle-guarded) into nested chains, maps Edit/Write/MultiEdit/NotebookEdit to diff items. Handles eviction-split orphans (tool_use gone / result left) + approval gating. 12 unit tests. **`src/components/RenderItems.tsx`** — MarkdownText (`react-markdown`, no raw HTML = safe, + `rehype-highlight`), ToolPair, DiffPair (`diffLines` unified view, default-open), TaskChain (recursive, default-collapsed). Per-item collapse = component-local `useState` (NOT the drawer's single sessionStorage key). **ClaudeChat.tsx**: `frames.map` → `renderItems.map` + pending-only ApprovalCards. A tool flips ApprovalCard→resolved pair once its `tool_result` arrives (`resolvedToolIds` memo). `renderFrame()` deleted. Everything derived `useMemo` over `frames` → R2 bounded-500 append stays the only writer, getSnapshot cached. New deps: `react-markdown`, `rehype-highlight`, `diff`. `index.css` `.bs-md`/`.bs-tool`/`.bs-diff`/`.bs-task` + hljs theme on the bs palette, ASCII-only.

### RV3-B (Code-8ro) — file-nav pane

New RV1 leaf type, read-only (nav not edit; Claude does edits). **BE `src-tauri/src/fs.rs`** (+`ignore` crate = ripgrep engine): `list_dir(path)` gitignore-aware, one level, dirs-first, `MAX_ENTRIES=2000`, pure `std::fs`+`ignore::WalkBuilder` (NO subprocess — R3.5 PATH/fd discipline; lazy per-expand, never walks a whole repo); `read_file(path,maxBytes)` bounded UTF-8 prefix (256KiB default, 4MiB hard cap), flags truncated+binary. +3 rust tests, registered in lib.rs. **FE**: `lib/fsBridge.ts` (invoke wrappers), `lib/fileTree.ts` (`buildFileTree` materializes shared `TreeNode[]` from a lazy dir cache — `TreeNodeKind` widened with `'dir'|'file'`), `components/FileTree.tsx` (virtualized `@tanstack/react-virtual`, same 28px rows; vim j/k/h/l/Enter/g/G; lazy dir load on expand; inline read-only preview). `termPanes.ts`: additive `fileNav?` leaf field + `isFileNavLeaf`/`newFileNavLeaf`/`spawnFileNav` mirroring the `agent?` precedent; `activeIsFileNav` mirror bit — **7 tree helpers untouched**. `TerminalPanes.tsx` `FileNavPaneLeaf`. `useVimNav.ts`: `<leader>e` spawns file-nav; pane-op mode lets a focused file-nav pane own its nav keys (they bubble to the tree's own keydown). `App.tsx` `filenav:spawn`→`spawnFileNav(active.path)`.

### RV3-C (Code-ia4) — nav→agent glue

`termPanes.resolveTargetAgentBridge()` (focused agent, else sole agent, else null=ambiguous). FileTree `s` = send cursor path to the resolved agent via `claude_send`; `y` = yank path to clipboard. Transient hint (auto-clears 3s) + footer advertising l/Enter/s/y. `filenav:open` event also dispatched on preview (extra seam). The one-window loop: navigate → `s` → watch the diff render as Claude edits.

**Verification:** `cargo check`+`build` clean, `cargo test` **14/14** (4 claude, 3 fs, +7 existing), `tsc` clean, `npm run build` clean (audit-emoji **0/48**), `vitest` **25/25** (+12 renderItems). Built binary boots clean (fd limit raised, no panic).

**STILL OWED — the combined live Tauri-window pass** (headless can't drive the WKWebview; same limitation as every prior phase). Must verify by hand:
- RV2-fix: switch projects several times with agent panes open → issues do NOT vanish; quit → `ps aux | grep 'claude --print'` shows zero survivors (CloseRequested reap); `<leader>x` kills only that pane's child.
- RV3-A: a real Claude turn renders paired tool_use+result collapsibles, markdown + highlighted fences, an Edit as a readable diff, a Task as a nested chain; frames stay bounded (F12 overlay, no getSnapshot warning).
- RV3-B: `<leader>e` opens a file tree (gitignore respected), j/k/h/l/Enter navigate + preview; coexists with shell+agent panes (split/tab/focus/zoom/close).
- RV3-C: `s` on a file sends it to an agent pane which then acts on it.

**Candid re-assessment (does the app now replace cmux+nvim for the user's loop?):** With RV1 shells + RV2 agents + RV3 nav+rich-rendering, the three value phases cover the "one-window everything" thesis *in code*. Remaining gaps to full parity: (1) no cross-restart layout persistence (RV1.1); (2) file-nav is read-only — any hand-edit still needs an external editor (by design, possibly forever); (3) no LSP/language intelligence; (4) reboot chrome (whichkey/palette/themes = R5/R6/R11) still absent — optional polish; (5) **none of it is live-verified** — the whole thesis rests on a manual window pass that keeps being deferred. That verification is now the single highest-value next action, ahead of any new feature.

**Next:** run the live pass → close Code-51e/d3p/8ro/ia4 (currently blocked-open pending it) → then R4 soak (owns the live-measurement harness) or stop and polish.

---

## RV3.4 — leader escape hatch (Cmd-P) · 2026-08-01 · Code-6xu (closed)

Live-surfaced P1 bug (screenshot 2026-08-01): with focus in the "ask claude" textarea or xterm, pressing **Space never armed leader** — all `<leader>` project commands were dead from any editable. Root: `useVimNav`'s editable-target bypass (`:360 return`) plus the terminal insert-mode early-return (`:146 return`) swallow the arming Space; `leaderChordActive` (RV2 `db6bd7e`) only let the SECOND chord key through, never the first Space that arms. Works fine from board/sidebar (non-editable). A bare Space in an input can't be special-cased (kills typing spaces).

**Fix (UX option c — explicit non-colliding chord):** a global **Cmd-P (mac) / Ctrl-P** arm, handled at the very top of `onKeyDown` — before the terminal block AND the editable bypass — so it works uniformly in xterm/agent-input insert mode, legacy chat, and board. It blurs any focused editable, drops insert (`setInsert(false)`), and arms leader (`setLeaderActive(true)`) with the same persistent semantics as bare Space. Both `emit()`s write the `window.__bsVim`/`__bsTerm` mirrors **synchronously**, so the next keydown resolves via whichever leader path owns the current focus (terminal pane-op switch, or global switch via `leaderChordActive`). `WhichKey.tsx` gains a footer line ("Space arms leader · Cmd-P arms from any input") for discoverability.

**Files:** `src/hooks/useVimNav.ts` (arm block + header doc), `src/components/WhichKey.tsx` (footer), `src/hooks/useVimNav.test.tsx` (NEW). **Test gotcha:** jsdom does NOT retarget `window.dispatchEvent`, so a window-dispatched keydown has `event.target === window` and `isEditableTarget` stays false — the regression test must dispatch from `document.activeElement` to exercise the editable path.

**Verification:** vitest **32/32** (+2 mutation-verified: arm-from-focused-input, armed-second-key-resolves — both FAIL when the arm guard is neutered). `npm run build` clean (audit-emoji 0/50). `cargo check` exit 0 (no Rust touched). **NOT live-verified in the WKWebview** (same headless limit as every phase) — the manual pass owes: Cmd-P from the Claude input arms the which-key menu, then `b`/`c`/`p`/`x` fire.

---

## RV3.5 — boot hotfix · 2026-08-01 · Code-b87 (closed, already-shipped)

Audit found all 5 boot bugs from the 2026-07-22 screenshots were **already fixed across prior RV commits** — nothing new to code. Verified sites: (1) fd exhaustion — `lib.rs:18-45` setrlimit `RLIMIT_NOFILE → min(hard,8192)`; (2) missing-bd-db — `bd.rs` `BdOutcome::NoDatabase` classified, reads map to `Ok(vec![])` (:202/:228), writes stay `Err`; (3) claude `--verbose` — `claude.rs:152` present; (4) MorningConfirm once-per-launch — `App.tsx:138` gate + `handleResume`/`handleNew` seed `confirmedFor` with ALL project ids, R3.5 render-loop fixed via stable `useCallback`; (5) git PATH — `bd.rs:350` `bd_git_branch` uses `binresolve::resolve_bin("git")`. Closed as already-implemented.

---

## RV3.3 — shared bd snapshot cache · 2026-08-01 · Code-1t8 (closed)

Live-surfaced P1 (2026-08-01): Board (`bdReady`+`bdList`), IssueList (`bdList`), and Statusline (`bd_counts` = `bd_ready`+`bd_list`, on a 5s poll AND its own raw `bd_changed` listener) each fetched bd **independently** — one change event spawned ~5 cold starts of the 130MB `bd` wrapper through the lockf semaphore, serialized. Measured `bd_counts` 3.7→8.0s escalating; boards felt dead/stale = "unusable".

**Fix — one shared, in-flight-deduped snapshot per `repoPath`:**
- **Backend `bd.rs`:** new `bd_snapshot` command = `try_join!(bd_ready, bd_list)` returning `{ ready, all }` (same shape `bd_counts` computed internally). Registered in `lib.rs`. `bd_counts` + `BdCounts` **kept** for back-compat (unused after rewire — user decision). `NoDatabase → Ok(vec![])` degradation on the underlying reads is inherited, so a db-less repo yields `{ ready:[], all:[] }`.
- **FE `src/lib/bdCache.ts` (NEW):** module-level `Map` store + `useSyncExternalStore` hook `useBdSnapshot(repoPath)`, mirroring the `BdLiveProvider` ref-count pattern + the termPanes/vim cached-snapshot discipline (store object REPLACED not mutated — avoids the R3.5 getSnapshot loop). **In-flight dedup**: N concurrent consumers (or mount + a `bd_changed`) share ONE `invoke('bd_snapshot')`. **Self-heal**: the RV3.2 transient-empty anti-latch moved here — a settled `loaded && empty && !error` snapshot schedules ONE 4s retry (not a steady poll), cleared the instant issues/error arrive. Change signal is the existing `useBdLiveContext` fan-out → `invalidate`.
- **Rewired all 3 consumers:** Board derives columns in a `useMemo`/effect off the snapshot, guarded by `dragGenRef` (gen-guard preserved — Board.test.tsx still green); post-mutation `invalidate(repoPath)` replaces the old `setVersion` refetch. IssueList reads `snap.all`. Statusline derives counts client-side from `snap.all[]` + `snap.ready.length` and **dropped** its 5s `bd_counts` poll, its raw `bd_changed` listener, and the `bd_counts` call (branch fetch kept, refreshed on `bd_changed`).

**Decisions (user):** refresh = event-only, no poll (watcher + mount drive it; self-heal is the one retained timer); backend = add `bd_snapshot`, keep `bd_counts`.

**Files:** `bd.rs` (+`bd_snapshot`/`BdSnapshot`), `lib.rs` (register), `types/issue.ts` (+`bdSnapshot`/`BdSnapshotData`), `lib/bdCache.ts` (NEW), `Board.tsx`, `IssueList.tsx`, `Statusline.tsx`, `lib/bdCache.test.ts` (NEW), `Board.test.tsx` (mock `bd_snapshot` + reset cache).

**Verification:** `cargo check` 0 · `npm run build` clean (audit-emoji 0/52) · vitest **36/36** (+4 bdCache: dedup + self-heal, both mutation-verified — dedup break → 1 fail, self-heal break → 2 fail; Board gen-guard still green). **OWED live pass:** open Beads-Station tab → board + sidebar + statusline all populate from ONE fetch; with `RUST_LOG=beads_station=debug`, one `bd_changed` logs ONE `bd_snapshot` (not a 3-component burst); counts no longer lag the board (RV3.2 split gone); no getSnapshot/render-loop warning.

**LIVE-VERIFIED (2026-08-01, `tauri dev` + Chrome-shim pass):** RV3.3 confirmed — one real `bd` write = exactly ONE `bd_snapshot` (delta 1, not 3); FE cache is loop-free in Chrome (2 calls = StrictMode double-mount, then stable). BUT the live pass **surfaced RV3.6** (below) — a pre-existing watcher self-trigger loop that RV3.3 made the sole visible driver.

---

## RV3.6 — watcher self-triggers on Dolt internals · 2026-08-01 · Code-niv (closed)

**Found by the live pass.** `tauri dev` with `RUST_LOG=beads_station=debug` showed `bd_snapshot` firing every ~2-4s **forever, app idle, no user action** — each call 7-9s cold. Not RV3.3's cache (Chrome proved it loop-free), not the FS (a top-level `.beads` mtime scan showed nothing). Instrumenting the watcher's emit revealed every `bd_changed` path was `.beads/embeddeddolt/Code/.dolt/noms/manifest` (+ `journal.idx`, `nbs_manifest_*`) — **bd's embedded Dolt storage**.

**Root cause (predates RV3.3):** `watcher.rs` watched `.beads` `RecursiveMode::Recursive` with NO path filter. Embedded Dolt rewrites `.dolt/noms/manifest` on every READ, so each `bd_snapshot`'s `bd ready`/`bd list` → manifest rewrite → FSEvents → `bd_changed` → FE `invalidate` → `bd_snapshot` → manifest rewrite → **infinite loop**. Any `bd_changed` consumer would have looped; RV3.3 just made it the only caller so it stood out. (`find -newermt` missed it — sub-second manifest rewrites between 2s samples.)

**Fix:** `is_dolt_internal(path)` in `watcher.rs` — skips any path whose components include `embeddeddolt` or `.dolt`, applied in the notify callback BEFORE `tx.send`. Only real issue-data writes (the passive `issues.jsonl` export, `config.yaml`, top-level `.beads` files) fire `bd_changed`. +2 rust unit tests (the exact looping paths ignored; `issues.jsonl`/`config.yaml`/`interactions.jsonl`/`last-touched` pass).

**Live-verified after fix:** idle 20s = **ZERO** `bd_snapshot`; a real `bd note` + export = exactly **1** refetch (not over-filtered). `cargo test` 16/16 (+2 watcher), build clean, vitest 36/36.

---

## Sidebar/statusline stranding + expectation audit · 2026-08-02

### Sidebar/statusline stranded on loading (Code-niv follow-up, commit 4c48db5)

Live screenshot: Board loaded but sidebar (IssueList) hung on "loading" and Statusline counts stuck at 0, though all read the same `useBdSnapshot(repoPath)`. Cause: `bdCache.subscribe()` deleted the store entry at refCount 0; StrictMode mount/unmount/remount + per-render resubscribe transiently zeroed refCount → entry dropped mid-flight → `applySnapshot` rebuilt a *different* entry and published only to its subscribers, stranding siblings. Fix: never delete the entry on unsubscribe (bounded by project count) — only clear the heal timer. +2 regression tests, entry-persistence mutation-verified.

### Expectation audit (11 confirmed gaps, 4 refuted) → all 11 fixed

Ran a 4-area workflow (19 agents: audit → adversarial verify) over the roadmap/issue history. Confirmed + fixed:

- **Code-hc9 (P0, degraded conflation) — commit 2fd2436.** The RV3.3 snapshot contract had no degraded/no-db flag; `bd_ready`/`bd_list` both map NoDatabase→`Ok(vec![])`, so a genuinely-empty repo and a real missing-db repo arrived identically and all 3 surfaces conflated them. Fix: `bd_snapshot` now runs `run_bd_classified` directly and returns `no_db` (true only when BOTH reads classified NoDatabase); threaded → `BdSnapshotData` → `BdSnapshotState.noDb`. Board/IssueList/Statusline gate "no beads db" on `noDb` (empty-real repo shows counts); Statusline renders distinct loading / bd error / no beads db / counts instead of silent 0s. Self-heal scoped to empty AND `!noDb` (missing db is stable, not a degrade). +2 rust (parse_read) +4 bdCache tests.
- **claude.rs concurrency (Code-8vm P1, Code-9wf P2, Code-uu5 P2) — commit d81c607.** (1) `claude_send`/`write_permission_response` held global SESSIONS lock across child stdin write+flush → stdin is now `Arc<Mutex<ChildStdin>>` per session, cloned under the map lock then written outside it. (2) `claude_start` same-bridge race loser reaped `child.wait().await` under the lock → now drops guard first. (3) leaked agent sessions never dropped (kill_on_drop only fires on drop) → new `claude_reconcile(live_bridges)` command reaps sessions absent from the pane tree; App.tsx calls it debounced on every pane-tree change via `allAgentBridges()`.
- **R8/R9 render (Code-dz5, Code-sc4 both P2) — commit bef4bc9.** Added `rehype-sanitize` (was absent; markdown XSS was inert only by react-markdown default) with a schema permitting className on code/pre/span. DiffPair gained a unified↔side-by-side toggle (split two-column layout) + a `+N −M` header delta. +RenderItems.test.tsx (4 tests).
- **Code-1u9 (P3) — commit 5bca156.** `get_or_mint_session_id` now `store.save()`s immediately after minting so an early `?` return can't drop the UUID (session-id stability).

**Refuted (4, correctly NOT fixed):** Code-urn spawn-lock (already fixed in b4bfb2a), closeActivePane sibling-remount (no defect — stable pane keys), tab-close orphan-reaper (no such code path exists), unknownFrameWarnings telemetry (fabricated expectation — no such spec).

**Gates across the session:** cargo test 18/18, vitest 44/44, build clean (audit-emoji 0/53). New bd issues Code-8vm/9wf/uu5/dz5/sc4 filed + closed; Code-hc9 + Code-1u9 closed.

---

## R12 — Live-verify harness (2026-08-07)

The root cause of "Beads Station just doesn't work" was diagnosed as a missing *capability*, not bad code: every prior session ended "code landed, unit gates green, owed live pass (headless can't drive WKWebview)." Frontend bugs that only manifest under real focus/keydown shipped "fixed" and reappeared (Code-ape a/d approval). A pivot to a neovim/cmux/Svelte stack was evaluated and rejected — it trades a fixable verification gap for a larger integration problem, and the current app is ~70% of the described vision already.

**Platform constraint (locked):** macOS has no `WebKitWebDriver`; `safaridriver` drives Safari, not the embedded WKWebView. The real bundle is undriveable by WebDriver on macOS. So the harness drives **Chromium via Playwright against the vite dev server (:1420)** with a dev-only **`mockIPC` shim**. This verifies frontend behavior (focus, keydown, a/d, pane isolation, render) — the debt that actually recurs — NOT the WKWebView layer or the real Rust backend (those stay on `cargo test`).

**How it works:**
- `src/test-harness/mockIpc.ts` — `mockIPC(router, { shouldMockEvents: true })` patches `window.__TAURI_INTERNALS__.invoke`, covering both scattered direct `invoke()` and `safeInvoke`'s dynamic `import('@tauri-apps/api/core')` in one install. `emit()` delivers events to the app's `listen()` handlers. Records `window.__bsInvokeLog` for assertions.
- `src/test-harness/{fixtures,boot}.ts` — seed 2 projects + 6 issues; boot entry imported from `main.tsx` only when `import.meta.env.VITE_LIVE_MOCK` (dynamic import → tree-shaken from prod; verified no harness strings in `dist/`).
- `tests/live/helpers.ts` — `boot`, `spawnAgentPane`, `leader` (blurs editable before Space), `emit`, `invokeLog`, `termMirror`.
- `tests/live/approval-ad.spec.ts` (Code-ape) + `tests/live/pane-isolation.spec.ts` (Code-51e).
- `playwright.config.ts`, `npm run test:live`. `vitest.config.ts` excludes `tests/live/**`.

**Gotchas discovered:** (1) app boots with one agent pane already present — measure pane counts relative to baseline. (2) `leader()` must blur the focused editable before Space or the keydown bypass swallows it. (3) ApprovalCard UNMOUNTS on resolve (ClaudeChat.tsx:451 `isApprovalPending`→false), so the resolved `[ok] approved` variant is dead code for permission_request frames — assert resolution via the invoke log + pending-card-gone, not a resolved DOM node. Filed Code-x5l (P3) for the UX gap.

**RV3 audit finding:** RV3-A (`d3p`, rich render), RV3-B (`8ro`, file-nav pane + Rust fs.rs) are BOTH already code-complete with unit tests — they sat `in_progress` only because they owed a live pass. Same debt for RV2 (`fpc`). The whole RV3 epic is "built, never live-verified, never closed." Each now has a live-spec close criterion in its bd notes.

**Gates:** test:live 8/8, vitest 44/44, cargo check clean, build clean, dist/ harness-free. Closed Code-ape + Code-51e (live) + Code-4vs (R12). Branch `r12-live-verify` pushed to origin.

---

## RV4.0 + DU1 + DU2 — vibecode Formula + Designer UI skin (2026-08-11)

Three tracks, orchestrated as one ultracode workflow (opus for schema/graph, sonnet for the mechanical theme, verify pass adversarial). shell-ui (`DAS/shell-ui`) was evaluated as a Designer-UI base and rejected as **reference only**: it's work's engagement-layer micro-frontend shell (pnpm monorepo, node 24, runtime ES-module composition) — adopting it wholesale would wrap Beads-Station as a micro-frontend, contradicting the Tauri single-app design and the DU plan's own "React skin, don't fork" recommendation.

**RV4.0 (`Code-90j`, in_progress — pilot done, deps still open):** the vibecode loop authored as a bd Formula, zero app code. `.beads/formulas/vibecode.formula.json` cooks to a 5-step DAG (triage → build → review → human-gate → close) with a `gate:{type:human}` on the gate step. Verified for real: poured molecule `Code-mol-iuk` against a live bead, the human gate was confirmed OPEN and blocking the close step, `bd ready` surfaced only triage. Ephemeral test mol/wisp burned; proto + formula file kept. Left `in_progress` because its declared deps `Code-ab4` (RV3 epic) + `Code-ky4.7` (Phase 7 daily writer) are still open — the formula was authored ahead as a pilot (prompt §8 allows this). Do NOT `--force` close; it closes when the deps land.

**bd formula schema quirks (bd 1.0.4, learned empirically — no example on disk):** top-level name key is `formula` NOT `name`; `type` must be `workflow|expansion|aspect` (`molecule` rejected); `gate` is a step-level object, only `{type}` is honored (extra subfields silently dropped); the declared `variables` block is decorative — bd auto-detects vars by scanning `{{...}}` in steps, and runtime mode still demands `--var` (defaults not honored); `depends_on` = array of step `id`s; `phase:"vapor"` is correct for an operational loop (wisp-friendly). A vapor **wisp** collapses to a single 0/0 root with no live per-instance gate — you must **pour** (persistent) to observe the gate blocking; that's why the acceptance test poured.

**DU1 (`Code-abe`, closed):** light designer theme + shell behind `?ui=designer`, strictly additive (default terminal/tokyonight path untouched). `src/theme/designer-light.css` token set (white surfaces, `#f5f5f7` bg, orange accent, blue/green/amber/red status — no purple, no AI-gradient). `src/components/designer/DesignerShell.tsx`: top bar + wordmark + Everyday/Heavy tier toggle, WORKSPACE sidebar + ACTIVE TIER card, CSS-grid calm layout.

**DU2 (`Code-3pk`, closed):** `src/components/designer/BeadGraph.tsx` — hand-rolled left-to-right dependency DAG (no dagre/elkjs), status-colored rounded nodes, count strip + legend, next-pickable highlight from `bd_ready`.

**Verify P1 caught + fixed (the reason to run the adversarial pass):** BeadGraph first drew edges from `Issue.parent`, which is **empty in real bd data** (0 parents; 14 blocker edges live). The centerpiece rendered a disconnected list, not a DAG. Root cause: the wire `Issue` only carried scalar `dependency_count`/`dependent_count`; bd's `--json` actually emits a full `dependencies` edge array (`{issue_id, depends_on_id, type}`) that the Rust `Issue` struct was dropping. Fix threaded it through: added a `Dependency` struct + `dependencies` field to `src-tauri/src/bd.rs` and the TS `Issue` (`src/types/issue.ts`); BeadGraph now derives columns + edges from `dependencies` (`depends_on_id` blocks `issue_id`). Live data renders 23 nodes / 14 edges.

**Gates:** tsc clean, vite build ok, cargo check clean, vitest 44/44, Playwright live-verify 8/8. Commit `3325d1d` pushed to `origin/r12-live-verify`.

---

## RV4.1 — the conductor pulse (2026-08-11)

The scheduler RV4.0 was missing. `src-tauri/src/conductor.rs` (`Code-wvl`) — a tokio-interval scheduler firing ONE ephemeral `claude -p` run per tick. Pulse sequence: `bd prime` (context) → `bd doctor` (health gate) → `bd ready` (top priority bead) → one-shot `claude` advancing exactly ONE molecule step → `bd remember` heartbeat. State lives entirely in bd; a killed pulse costs one retried step (next pulse re-derives from `bd ready`/`bd mol`).

**Two locked safety decisions (this session):** (1) **default OFF** — nothing auto-starts in `lib.rs::setup`; a live claude pulse fires only after an explicit `conductor_start`. (2) **bd-state only** — the pulse ships **dry-run by default** (`claude --permission-mode plan`: reasons + read-only bd verbs, no edits); real diffs stay gated behind the formula's human gate (RV5.0). `dry_run: Some(false)` opts into `acceptEdits`.

**Design:** `conductor_start(interval_secs?, repo_path, dry_run?)` / `conductor_stop` commands. First `tokio::sync::Notify` + `tokio::select!` in the backend — the loop selects stop-notify vs interval tick; stop halts the schedule at the next boundary, never aborts an in-flight pulse. Off-minute jitter (one-time pre-loop offset), idempotent same-repo start, replace-on-different-repo, `PULSE_TIMEOUT < interval` (non-overlapping ticks). `conductor_status` event (`waking|awake|idle|deferred|error|stopped`) for the DU footer + DU3 panel — FE wiring is a later phase, not this ticket. Model `claude-haiku-4-5-20251001`.

**Molecule-advance model (confirmed bd 1.0.4):** no `bd mol advance` verb. A molecule is a real bead DAG; "advance one step" = work the ready step, `bd close <step>`, which unblocks the next. bd verb arg shapes confirmed: `bd defer <id>` (no `--reason`; use `bd note`), `bd remember "<insight>" --key heartbeat` (insight positional), `bd doctor` (exit status = health, no `--json`).

**Reuse (no duplication of the RV3.1 fork-storm guard):** `bd.rs` — new `pub(crate) run_bd_verb` wrapper over private `run_bd_classified` so the conductor's doctor/defer/note/remember share `BD_SEMAPHORE` + EAGAIN retry; `ACTOR` made `pub(crate)`. `claude.rs` — `CLAUDE_BIN_FALLBACK` + `augmented_path` made `pub(crate)`; ANTHROPIC env-forward duplicated (5 lines) rather than refactoring the persistent-session path. `lib.rs` — `mod conductor` + handler, no auto-start.

**Gates:** cargo test 5/5 conductor (jitter bounds, interval default/floor, bd arg builders, prompt safety contract), full cargo 23/23, tsc clean. **NOT yet done** (needs a live app; WKWebView undriveable headless): manual short-interval smoke, mid-step-kill idempotency, FE footer wiring + mockIPC status assert. `Code-wvl` stays open until RV4.0's dep chain (RV3 `Code-ab4` + Phase 7 `Code-ky4.7`) clears. Commit `70683d1` pushed to `origin/r12-live-verify`.

---

## RV2 + RV3 live-verify — the leaves close (2026-08-11)

The RV2/RV3 leaves were code-complete since R12 but sat `in_progress` owing only a live pass. Wrote the three missing Playwright + mockIPC specs; live suite now **15/15** (was 8). All selectors were derived from the real components (no test-hook additions needed):

- `tests/live/agent-render.spec.ts` (`Code-d3p`): emits real `claude_event:<bridge>` frames into a spawned agent pane. Asserts a tool_use + matching tool_result render as ONE collapsible ToolPair (`.bs-tool`), an Edit renders a DiffPair (`.bs-tool.bs-diff`) with a +/- delta toggling unified (`.bs-diff-body`) ↔ side-by-side (`.bs-diff-split`), a Task frame nests `parent_tool_use_id` children into a recursive TaskChain (`.bs-task`).
- `tests/live/filenav.spec.ts` (`Code-8ro`): leader-e spawns a filenav pane (`activeIsFileNav`), j/k move the cursor (`.bs-tree-row--active`), open shows a read-only `.bs-filepreview` (no editable).
- `tests/live/nav-to-agent.spec.ts` (`Code-ia4`): with an agent pane present, selecting a file row + `s` fires `claude_send` to the target agent bridge with the path (asserted via the invoke log).
- `mockIpc.ts`: added `list_dir`/`read_file` fixtures (a small deterministic tree + file preview) — before, both returned null so a filenav pane rendered empty.

**Harness gotchas found:** (1) the filetree is rooted at the project dir, so row 0 is `beads-station` (root), then `src`/`README.md`/`package.json` — nav counts must include the root row. (2) keyboard nav (`j`/`k`/`s`) only reaches the FileTree window keymap when the pane is active AND `vim.focused === 'terminal'`; with a second (agent) pane present, a raw blur is not enough — **clicking the target row** focuses the tree reliably and is the robust user-action path. (3) a stale vite dev server on :1420 makes Playwright serve a non-mock build and every spec fails at `__bsMockReady` — kill `lsof -ti:1420` before a run.

**Closed:** `Code-d3p`, `Code-8ro`, `Code-ia4` (RV3 leaves), `Code-ab4` (RV3 epic), `Code-fpc` (RV2). This clears ONE of RV4.0's two dependencies. **Only Phase 7 (`Code-ky4.7`, Obsidian daily writer) now gates the entire RV4/RV5 conductor chain** — it is the single next unblock for closing `Code-90j` (RV4.0) and `Code-wvl` (RV4.1). Gates: live 15/15, vitest 44/44, tsc clean. Commit `03e1604` pushed.

---

## Bug-bash from screenshots (2026-08-11)

Ronit ran the app and flagged 8 issues. Triaged into bugs (fixed) + features (3 shipped, 1 design fork, 1 deferred).

**THE big one — ask-claude sends nothing, cost always $0 (`Code-f1u`, fixed):** root cause was the **stale repo `.env` clobbering the live Gateway environment**. The `.env` (dated Jun 15) had `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL=http://localhost:6655` (no `/anthropic/` path); Gateway now uses `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=http://localhost:6655/anthropic/` (source of truth = `~/.claude/settings.json`). `envloader::install_into_process_env` forced the `.env` into the process env via `set_var`, OVERRIDING the correct inherited values, so claude spawned against a dead endpoint, produced no stream-json frames, and cost never moved. Fixes: (1) envloader now SKIPS any var already present in the environment (live env wins; `.env` only fills gaps — unit-tested `install_does_not_clobber_existing_env`); (2) the machine-local gitignored `.env` was rewritten from `~/.claude/settings.json`; (3) `ClaudeChat.send()` no longer swallows the `claude_send` error in a bare try/finally — a failed send now shows a stderr frame. **Lesson: when claude produces no output + cost stays $0, suspect ANTHROPIC_BASE_URL/AUTH_TOKEN, not the send path — and check that the `.env` matches Gateway's current settings.**

**Cost meter (`Code-9d8`, core fixed):** cost was $0 ONLY because send was broken — `claudeUsage.ts` already accumulates `total_cost_usd` + tokens from claude `result` frames, and CostMeter renders it. With send fixed, per-session cost/in/out/cache populate live. The Gateway AGGREGATE view (today/month totals like the popover) is deferred — the `localhost:6655` proxy exposes no discoverable usage API (probed /usage /stats /metrics /anthropic/usage; all 404/401; root says "Local gateway Proxy is running").

**Sidebar header clipped (`Code-4k5`, fixed):** `.bs-issuelist-header` had no CSS rule at all, so "BEADS · ALL (16)" sat flush against the window edge. Added a rule matching the tree-row inset.

**Stray template steps on board/sidebar (`Code-m7u`, fixed):** a persisted bd formula proto leaves an uninstantiated template epic + step children ("Triage {{bead_id}}") that bd surfaces in `bd ready`. `bdCache.applySnapshot` now filters template artifacts once for all consumers (drops issues labeled `template` or with an uninstantiated `{{var}}` in the title).

**Shipped features:** Shift-Tab / Ctrl-Shift-Tab project cycling (`Code-eu0`); sidebar collapsible (leader-\\) + drag-resizable 180-640px, width persisted (`Code-kr9`).

**Design fork (`Code-x8p`, reclassified bug→feature P1):** "switching project loses everything" — the board/sidebar DO swap correctly; the terminal shows the old project's shell because the pane surface is NOT keyed by project (RV1 persistence design). Ronit chose **per-project shells (CMUX-like)**: key the pane tree by projectId, persist a per-project pane-tree map, restore on switch. Not yet built.

**Deferred (`Code-3yn`):** terminal resize hotkeys + embed neovim. Full writeup in `Documents/Beads/Implementation Prompts/2026-08-11 Terminal resize + neovim embed (deferred).md`. Recommendation: ship resize (mirror the sidebar-resize pattern + existing `pty_resize`) + Option A (run nvim in the existing xterm PTY, add a file-nav→nvim open); defer nvim --embed; reject Monaco.

**Gates for the bug-bash batch:** tsc clean, vite build ok, cargo 24/24 (+1 envloader test), vitest 44/44, Playwright live 15/15. Commits `92d4a74` (3 bugs) + `42b9ae0` (2 features) pushed.

---

## Phase 7 + RV4 arc complete — Obsidian writer, epic fanout, token tiers (2026-08-12)

Ultracode autonomous session. Landed the single blocker (Phase 7) that gated the whole conductor chain, then drove RV4.2 + RV4.3 to close. RV4 arc (4.0/4.1/4.2/4.3) now fully shipped; only RV5.0 (cockpit gate view) + RV5.1 (sensors) remain.

**Phase 7 (`Code-ky4.7`, closed) — Obsidian daily writer.** `src-tauri/src/daily.rs`: an append-only, local-wall-clock (chrono::Local) writer at `~/Documents/Beads/Daily/{YYYY-MM-DD}.md`. H1 `# {date} — Beads Update` written once; `## HH:MM — <title>` subsections appended in arrival order. **Append-only via `OpenOptions().append(true)`** (never read-modify-`fs::write`) so a concurrent pulse/FE call can never clobber a section — a 16-thread test proves zero section loss. `has_header` dedup recognizes BOTH the spec H1 and the older bare `# {date}` form so it never stacks a second header onto a human-started file. `daily_append(title, body, dir_override?)` command + `src/lib/dailyBridge.ts` wrapper + mockIpc route. Was the ONE blocker for the RV4/RV5 chain (its dep `Code-ky4.3` was already closed). 6 unit tests. `chrono 0.4` (clock only) added.

**RV4.0 (`Code-90j`) + RV4.1 (`Code-wvl`) closed.** Both were code-complete/pilot-verified but pinned `in_progress` on the RV3 + Phase 7 dep chain. With Phase 7 landed, that chain is fully closed → both closed. RV4.1's remaining item (live-app short-interval smoke + mid-step-kill idempotency + FE footer wiring) is inherently manual — WKWebView is undriveable headless on macOS — and moves to a live-smoke follow-up, NOT a code gap.

**RV4.2 (`Code-jlt`, closed) — epic fanout via bd swarm + merge-slot.** The pulse now branches on `issue_type == "epic"`: `fanout_pulse` ensures a swarm molecule (`bd swarm create`, idempotent best-effort), reads `bd swarm status <epic> --json` → ready children, and spawns up to `MAX_FANOUT=3` concurrent builder pulses. Conflict resolution is delegated to bd's OWN `bd merge-slot` primitive — the builder prompt tells claude to `acquire`/`release` around shared-file edits; **the Rust scheduler invents no locking** (locked principle #1). `bd.rs` gained `swarm_status`/`swarm_create` + `SwarmStatus`/`SwarmNode` (share BD_SEMAPHORE + EAGAIN retry). `futures_join_all` spawns builders on the tauri runtime; **each result carries its own bead id inside the tuple** (never positional) so a dropped task never mislabels a survivor, and a `lost` count keeps `ok+failed+lost == n` honest. VERIFIED live at the bd level: scratch epic + 3 independent children → `swarm status.ready = 3`; `merge-slot acquire(A)` / refuse(B) `✗ Slot held by: builderA` / `release(A)` serialization confirmed no-clobber. 3 unit tests.

**RV4.3 (`Code-6zv`, closed) — token tiers (size → model).** `resolve_tier(labels)` reads a `size:S|M|L` label (also `sz:` / `size-` / long forms, case-insensitive) → `[S]` Haiku / `[M]` Sonnet / `[L]` Opus. Unlabeled → `[S]` (cheap-by-default, principle #4). A `model:<name>` label OVERRIDES the tier outright (per-bead override wins). `run_pulse_claude` now takes an explicit model arg; the single pulse resolves the top bead's tier, the fanout resolves each child's tier via a per-child `bd show` (semaphore-bounded). Removed the now-dead `PULSE_MODEL` const (`MODEL_SMALL` carries the same value). **Ceremony encoded DECLARATIVELY in `.beads/formulas/vibecode.formula.json`** per the plan: triage assigns a size label if unset; build/review rigor scales by tier; the human-gate step notes the `[L]` mandatory gate before+after. VERIFIED: `size:S/M/L` labels round-trip live (resolve_tier reads exactly what bd emits); formula still cooks to the 5-step DAG with the human gate. 6 unit tests (mapping, override precedence, distinct cost-ordered models, `[L]` gate+adversarial ceremony).

**Model IDs used (per §Environment):** `claude-haiku-4-5-20251001` / `claude-sonnet-5` / `claude-opus-5`.

**bd verb quirks confirmed this session:** `bd close` needs each id as a SEPARATE arg — a single quoted `"$IDS"` word fails to resolve. `bd merge-slot` is lazily created (`bd merge-slot create`); slot is a `<prefix>-merge-slot` bead labeled `gt:slot`. `bd swarm status --json` top keys: `epic_id, ready[], ready_count, active_count, blocked_count, completed[], blocked[]` — the fanout reads `.ready`.

**Gates (all three phases):** cargo **36/36** (24→30 Phase 7, →33 RV4.2, →36 RV4.3), tsc+vite+emoji clean, vitest **44/44**, Playwright live **15/15**. Commits `29515c5` (Phase 7), `ed9392c` (RV4.2), `cce0f92` (RV4.3) + `64a0fa1` (bd export) pushed to `origin/r12-live-verify`.

**Newly ready / next up:** `Code-ew0` (RV5.0 — cockpit gate view: list open `human` gates in-app, approve = close gate, reject = reopen step w/ note) is the next §8 phase and a FRONTEND track (fresh context recommended). `Code-qqa` (RV5.1 — sensors, Obsidian first) follows. The RV4 backend's live-app smoke (conductor short-interval tick, mid-step-kill idempotency, DU footer status wiring) is the outstanding manual verification across the arc.

---

## RV5.0 — cockpit gate view (2026-08-12)

Same autonomous session as the RV4 arc. Built the FIRST piece of RV5: an in-app view of bd's human gates with approve/reject. The gate model is **bd-native** (confirmed by probing: `issue_type == "gate"`, `await_type == "human"`, `status == "open"`, plus an `is_template` flag on the uninstantiated formula-proto gate) — so this phase is the VIEW only, no new gate model.

**Backend (`bd.rs`):** `bd_gate_list` parses `bd gate list --json` and returns only actionable gates via the pure `actionable_human_gates` filter (`!is_template && status=="open" && await_type=="human"` — drops the proto template, closed gates, and timer/gh/bead gates that self-resolve). `bd_gate_resolve` = the APPROVE action (`bd gate resolve <id>`, which closes the gate AND re-evaluates its blocked step — distinct from `bd close`). The `Gate` struct is **snake_case (NO camelCase rename)** because bd emits snake_case; the TS bridge reads the same field names. (A camelCase rename here was the first-cut bug — serde applies one rename to both directions, so `await_type`/`is_template` failed to deserialize and the filter returned 0. Caught by the unit test.)

**Frontend:** `src/lib/gateBridge.ts` (typed wrappers, snake_case fields) + `src/components/designer/GateCockpit.tsx` — a "NEXT UP · GATES" card mounted in the DesignerShell right panel (above the ACTIVE AGENTS placeholder). Approve = `gateResolve`; **Reject = `bdNote` the gate + leave it OPEN** (the honest "not approved" state: the step stays blocked pending changes; we never force-close). Live refresh is **self-contained** (initial fetch + a `bd_changed:<repo>` listen via `safeListen` + `AbortController`) — deliberately NOT `BdLiveProvider`, because `DesignerShell` returns from `App.tsx` BEFORE the provider wrap AND gates aren't in the bd snapshot (`useBdSnapshot` filters non-issue types). `repoPath` comes from `useProjects()` inside the component. On repo switch it resets `error` + `busyId` so a stale error/button-lock never bleeds across projects (review-caught).

**Verified:** bd-level approve flow proven live — poured a molecule from the vibecode formula, its `human` gate showed open + blocking, `bd gate resolve` closed it and the open-gate count dropped to 0. FE: 3 new Playwright specs (`tests/live/gate-cockpit.spec.ts`) — the card renders the mock gate, Approve fires `bd_gate_resolve` with the gate id, Reject fires `bd_note` without resolving. Designer specs use a lighter boot (`?ui=designer` + wait for `__bsMockReady`) since the shell's `__bsVim`/`__bsTerm` mirrors don't exist in the designer skin. Scratch molecule burned (`bd mol burn --force` — the bare verb prompts y/N and blocks agents).

**Gates:** cargo **37/37** (+1 gate filter test), tsc+vite+emoji clean, vitest 44/44, Playwright live **18/18** (was 15). Commit `22e78b2` pushed to `origin/r12-live-verify`.

**Conductor arc status:** RV4.0/4.1/4.2/4.3 + RV5.0 all closed. **Only RV5.1 (`Code-qqa`, sensors — Obsidian first) remains** — a sense-pulse watching `Implementation Prompts/` + `Daily/`, creating a bd **wisp** on a new prompt, surfacing it at the gate, `bd promote` on approval. Then Jira/Notion/mail via bd's native sync verbs. Outstanding manual verification across the whole arc: the RV4 conductor's live-app smoke (short-interval tick, mid-step-kill idempotency, DU footer `conductor_status` wiring) — all need the running app (WKWebView undriveable headless).

---

## When to update this file

- After every phase closes: append a one-liner to the phase table above.
- When a hardcode is removed or a configurable replaces a literal: update the "What's already on disk" hardcodes block.
- When a new locked decision is made: add a row to the decisions table.
- When tech debt accrues or burns down: edit the deferred-work list.

When you edit the in-repo copy, also write the same change to `~/Documents/Beads/BEADS-CONTEXT.md`. The two should be byte-identical.
