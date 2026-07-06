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
│   ├── lib/listenerRegistry.ts           # R0: safeListen<T>(channel, handler, options) wrapper over @tauri-apps/api/event listen(). Buckets channel by first-colon prefix (claude_event:{pid} → 'claude_event'). Increments/decrements a per-bucket count map ONLY in import.meta.env.DEV; production returns raw listen() unchanged. Exports getListenerCounts() snapshot + subscribeListenerCounts(cb) for useSyncExternalStore. Idempotent unlisten via `released` flag + Math.max(0, …) defense-in-depth. Not yet adopted by call sites — R1 migrates the 5 raw listen() sites.
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

## When to update this file

- After every phase closes: append a one-liner to the phase table above.
- When a hardcode is removed or a configurable replaces a literal: update the "What's already on disk" hardcodes block.
- When a new locked decision is made: add a row to the decisions table.
- When tech debt accrues or burns down: edit the deferred-work list.

When you edit the in-repo copy, also write the same change to `~/Documents/Beads/BEADS-CONTEXT.md`. The two should be byte-identical.
