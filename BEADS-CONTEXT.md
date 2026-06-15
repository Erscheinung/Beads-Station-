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
| 5: Issue tree + indent guides | `Code-ky4.5` | open, **ready** | 6, 9 |
| 6: Claude tool surface + cmux-style status | `Code-ky4.6` | open, blocked by 5 | — |
| 7: Obsidian daily updates | `Code-ky4.7` | open, **ready** | — |
| 8: First-run migration of `[Project]` brackets | `Code-ky4.8` | open, **ready** | — |
| 9: Command palette + vim keybindings | `Code-ky4.9` | open, blocked by 5 | 10 |
| 10: Polish + signed dmg | `Code-ky4.10` | open, blocked by 9 | — |

Run `bd -C ~/Code show Code-ky4.<N>` for full description / acceptance criteria of any phase.

---

## What's already on disk (through Phase 4)

```
~/Code/Beads-Station/
├── artifacts/Beads-Station.dmg          # 3.92 MB (was 3.8 in P3), aarch64, identifier ai.beads-station.desktop, unsigned
├── BUILD.md                              # phase 1 build report (still current — toolchain unchanged)
├── BEADS-CONTEXT.md                      # this file (canonical)
├── .env                                  # GITIGNORED — ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL for Gateway
├── .env.example                          # public template documenting the contract
├── rust-toolchain.toml                   # pinned to 1.90.0
├── package.json + node_modules/...       # +@tauri-apps/plugin-store (P2), +@dnd-kit/core +@dnd-kit/sortable (P3); P4: predev+prebuild → audit-emoji
├── scripts/audit-emoji.mjs               # P4: emoji-glyph gate. fails build on U+1F300-1FAFF / U+2600-27BF / U+2300-23FF / U+1F000-1F2FF in JSX text. ▼ U+25BC and › U+203A explicitly allowed.
├── src/
│   ├── App.tsx                           # P4: useVimNav() at top, project:cycle listener, sidebar focus boxShadow, gridTemplateRows '1fr 280px 22px', <Statusline> + <Dashboard> + <WhichKey> mounted
│   ├── main.tsx + index.css              # P4: full tokyonight Storm token set as --bs-* (bg/bg-dark/bg-float/bg-elev/fg/fg-muted/fg-faint/border/border-faint/blue/cyan/magenta/purple/orange/yellow/green/red/accent/shadow-card/shadow-modal). Legacy --bg/--fg/--bg-elev/--border/--accent kept as aliases. JetBrains Mono enforced via html/body/button/input/textarea/select rule + * { font-family: inherit }. .bs-grid-1px utility, .bs-tab::after diagonal slash separator, .bs-card hover composes priority bar + hairline shadow.
│   ├── state/projects.ts                 # P2: useProjects() hook + activeId in localStorage
│   ├── state/vim.ts                      # P4: useSyncExternalStore-based store {mode, leaderActive, focused}; mirrors to window.__bsVim
│   ├── hooks/useBdLive.ts                # P3: subscribes bd_changed:{repoPath} → debounced refetch
│   ├── hooks/useVimNav.ts                # P4: global window keydown — Space leader (1s window), p/b/c/s/q bindings, j/k/h/l per-pane routing, Tab/Shift+Tab on board, Enter/o issue:open, gq quit combo, INPUT/TEXTAREA/.xterm/.ProseMirror/contentEditable bypass
│   ├── types/issue.ts                    # bd Issue interface + ready/show/list/claim/setStatus/close/label/note helpers
│   └── components/
│       ├── IssueList.tsx                 # left pane: ALL READY (n) — bd ready --json
│       ├── Terminal.tsx                  # collapsible 280px ↔ 24px, xterm.js bound to PTY
│       ├── TabBar.tsx                    # P2/2.5: bufferline strip, ellipsis, scroll-into-view; P4: diagonal slash separator via .bs-tab::after, active gets BOTH 2px --bs-blue top+bottom
│       ├── ClaudeChat.tsx                # P2/2.5: per-project events, status dot, surfaces stderr+raw
│       ├── Board.tsx                     # P3: 4-column drag-drop, optimistic UI + rollback toast
│       ├── Column.tsx                    # P3: useDroppable
│       ├── Card.tsx                      # P3 useDraggable + P4: 3px inset priority bar via boxShadow, --bs-card-bar custom prop for hover composition, 13px/500 title, drag rotate -2deg + var(--bs-shadow-card)
│       ├── Statusline.tsx                # P4: 22px lualine — mode pill | path | branch | counts | spacer | clock | pending dot. Polls 5s + listens bd_changed:{repoPath}
│       ├── Dashboard.tsx                 # P4: empty-state ANSI Shadow BEADS ASCII + tip table; rendered when no projects or no active selection
│       └── WhichKey.tsx                  # P4: leader-overlay; subscribes useVim().leaderActive; centered modal, 5 hints (p/b/c/s/q)
└── src-tauri/
    ├── tauri.conf.json
    ├── Cargo.toml + Cargo.lock           # +tauri-plugin-store (P2), +notify 8.2 macos_fsevent (P3)
    └── src/
        ├── lib.rs                        # 25 commands registered (P4: +bd_counts +bd_git_branch), plugin-store + envloader init in run()
        ├── main.rs
        ├── envloader.rs                  # P2.6: .env loader (parses KEY=value, set_var into process env)
        ├── binresolve.rs                 # P2.5: canonical-dir-first binary resolver
        ├── bd.rs                         # P3: ready/show/list reads + claim/set_status/close/label/note writes; P4: +bd_git_branch (rev-parse --abbrev-ref HEAD; "(detached)"/"(no-git)" fallbacks) +bd_counts (BdCounts {ready,in_progress,blocked,closed}); current_dir over -C
        ├── pty.rs                        # pty_spawn, pty_write, pty_resize, pty_kill (portable-pty)
        ├── projects.rs                   # P2/2.5: scans ~/Code/, mints+persists session UUIDs, skips dirs with spaces
        ├── claude.rs                     # P2/2.5/2.6: per-project HashMap, namespaced events, ANTHROPIC_* forwarding, [claude_start] diag frame
        └── watcher.rs                    # P3: macOS FSEvents on <repo>/.beads/, 250ms debounce, emits bd_changed:{repoPath}

~/Documents/Beads/
├── SOURCE-PROMPT.md                      # original ask + locked decisions
├── IMPLEMENTATION-PLAN.md                # full plan (mirror of ~/.claude/plans/we-have-a-git-synthetic-dusk.md)
├── BEADS-CONTEXT.md                      # this file (mirror of repo copy)
└── Daily/2026-06-12.md                   # first daily rollup
```

**Remaining hardcodes (post-P2.5):**
- Claude binary path: `~/.local/bin/claude` is now a *fallback* — `binresolve::resolve_bin_or_default` checks the canonical-dir list first. Still a hardcode; Phase 6 makes it user-configurable.
- bd binary: now resolved via `binresolve::resolve_bin("bd")` — checks `~/.local/bin → /opt/homebrew/bin → /usr/local/bin → /usr/bin → /bin`, then PATH. No bare `Command::new("bd")` left.
- Project root: `~/Code/` is hardcoded as the scan root in `projects.rs`. Additional repos come from `~/Code/.beads/config.yaml` `repos.additional`. Phase 8 (first-run wizard) may add multi-root support.
- Spaces-in-dir-name skip: `projects.rs` drops any candidate whose basename contains a space, working around a suspected Claude CLI session-id transcript-path encoding issue. Phase 6 will replace this with a direct JSONL-replay path that doesn't care about the cwd shape.

**Phase 2 lifted:** target project path and per-project Claude session UUID are now caller-supplied. Each project gets a UUID auto-minted on first scan and persisted via `tauri-plugin-store` to `~/Library/Application Support/ai.beads-station.desktop/projects.json` (or wherever `app.store("projects.json")` resolves on macOS).

**Phase 2 events are namespaced:** `claude_event:{projectId}`, `claude_event_raw:{projectId}`, `claude_stderr:{projectId}`. Anything still listening on the bare `claude_event` name will silently miss frames.

---

## Locked design decisions (from planning Q&A — do not relitigate)

| Decision | Choice |
|---|---|
| cmux usage | **Conceptual model lifted, no code reused.** Parallel-isolated-agents-per-tab pattern (Phase 2), per-agent status badges + cost/token tracking (Phase 6). License is AGPL — code reuse would taint Beads Station. |
| LazyVim usage | **Aesthetic + functional patterns ported to web.** Tokyonight Storm tokens, neo-tree-shaped sidebar, lualine statusline, vim modal nav, which-key hints, telescope fuzzy switcher. Phase 4 + 9. |
| Default Claude permission mode | `acceptEdits`, per-project override available in Phase 6 |
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
- **`Code-urn` (P3)**: `claude_start` holds the SESSIONS tokio Mutex across `Command::spawn` — perf only; Phase 6 candidate.
- **`Code-1u9` (P3)**: `projects.rs` mints UUIDs into the store but only `.save()`s once at the end of the scan. Loop body is essentially infallible so this rarely matters; revisit if anyone reports vanishing IDs.
- **`Code-2a3` (P2)**: smoke-test that `claude --print --session-id <known-uuid>` actually replays prior frames to stdout. If it doesn't, Phase 6 needs to read `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` directly to seed scrollback. The P2 acceptance criterion "previous session's chat scrollback resumed via --session-id" hinges on this.
- **Phase 2 unmount-on-tab-switch**: `App.tsx` uses `key={active.id}` on Terminal and ClaudeChat, so a tab switch tears down the PTY and unsubscribes from Claude events (the Claude *child process* keeps running because `claude_kill` is not called from `ClaudeChat` cleanup). Phase 6 will keep PTYs and listeners alive across switches, mirroring cmux's parallel-isolated-agents-per-tab model.
- **Spaces-in-dir filter**: P2.5 workaround — projects.rs drops any candidate whose basename contains a space. Phase 6's JSONL-replay path should make this filter unnecessary; revisit then.

---

## When to update this file

- After every phase closes: append a one-liner to the phase table above.
- When a hardcode is removed or a configurable replaces a literal: update the "What's already on disk" hardcodes block.
- When a new locked decision is made: add a row to the decisions table.
- When tech debt accrues or burns down: edit the deferred-work list.

When you edit the in-repo copy, also write the same change to `~/Documents/Beads/BEADS-CONTEXT.md`. The two should be byte-identical.
