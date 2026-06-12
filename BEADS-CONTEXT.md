# Beads Station — Persistent Recovery Context

**Read this first if you are a new Claude session picking up this project.**

This document is the system of record for context that doesn't fit in code or in a planning markdown. It's deliberately stored in TWO places to survive bd data-loss events: this file inside the repo, and `~/Documents/Beads/BEADS-CONTEXT.md` in the Obsidian vault. They should be kept in sync. Bd issues are the canonical task tracker — the bd IDs below are the live source of truth for "what to do next."

---

## Critical operational gotcha

**`git config beads.role maintainer` is a hard prerequisite for `bd` to persist any writes.**

Without it, `bd create` returns a fresh ID and a green `✓ Created issue:` line, but the write is silently dropped — the issue does not appear in `bd list`, `bd show <id>`, `bd export`, or `bd ready`. The only visible signal is a `warning: beads.role not configured (GH#2950)` line on every command, easy to miss.

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

| Phase | ID | Status (as of 2026-06-12 19:30) | Blocks |
|---|---|---|---|
| Epic | `Code-ky4` | open | — |
| 1: Vertical slice | `Code-ky4.1` | **closed** (shipped commit `f3b24fc`) | — |
| 2: Project picker + per-tab Claude | `Code-ky4.2` | open, **ready** | 3 |
| 3: Jira board + drag-drop | `Code-ky4.3` | open, blocked by 2 | 4, 7, 8 |
| 4: LazyVim aesthetic + functional ports | `Code-ky4.4` | open, blocked by 3 | 5 |
| 5: Issue tree + indent guides | `Code-ky4.5` | open, blocked by 4 | 6, 9 |
| 6: Claude tool surface + cmux-style status | `Code-ky4.6` | open, blocked by 5 | — |
| 7: Obsidian daily updates | `Code-ky4.7` | open, blocked by 3 | — |
| 8: First-run migration of `[Project]` brackets | `Code-ky4.8` | open, blocked by 3 | — |
| 9: Command palette + vim keybindings | `Code-ky4.9` | open, blocked by 5 | 10 |
| 10: Polish + signed dmg | `Code-ky4.10` | open, blocked by 9 | — |

Run `bd -C ~/Code show Code-ky4.<N>` for full description / acceptance criteria of any phase.

---

## What's already on disk (Phase 1 deliverables)

```
~/Code/Beads-Station/
├── artifacts/Beads-Station.dmg          # 3.5 MB, aarch64, identifier ai.beads-station.desktop, unsigned
├── BUILD.md                              # phase 1 build report
├── BEADS-CONTEXT.md                      # this file (canonical)
├── rust-toolchain.toml                   # pinned to 1.90.0
├── package.json + node_modules/...
├── src/
│   ├── App.tsx                           # 3-pane layout, hardcoded to ~/Code/sample-project
│   ├── main.tsx + index.css              # JetBrains Mono base
│   ├── types/issue.ts                    # bd Issue interface + bdReady/bdShow/bdList helpers
│   └── components/
│       ├── IssueList.tsx                 # left pane: bd ready --json
│       ├── Terminal.tsx                  # center: xterm.js bound to PTY
│       └── ClaudeChat.tsx                # bottom: stream-json chat
└── src-tauri/
    ├── tauri.conf.json                   # productName "Beads Station", identifier ai.beads-station.desktop
    ├── Cargo.toml + Cargo.lock           # time pinned to 0.3.47
    └── src/
        ├── lib.rs                        # invoke_handler registers all 10 commands
        ├── main.rs
        ├── bd.rs                         # bd_ready, bd_show, bd_list (subprocess + --json)
        ├── pty.rs                        # pty_spawn, pty_write, pty_resize, pty_kill (portable-pty)
        └── claude.rs                     # claude_start, claude_send, claude_kill (stream-json subprocess)

~/Documents/Beads/
├── SOURCE-PROMPT.md                      # original ask + locked decisions
├── IMPLEMENTATION-PLAN.md                # full plan (mirror of ~/.claude/plans/we-have-a-git-synthetic-dusk.md)
├── BEADS-CONTEXT.md                      # this file (mirror of repo copy)
└── Daily/2026-06-12.md                   # first daily rollup
```

**Phase 1 hardcodes:**
- Target project path: `~/Code/sample-project`
- Claude session UUID: `00000000-0000-4000-8000-beadsphase01`
- Claude binary path: `~/.local/bin/claude`
- bd binary path: relies on PATH (typically `~/.local/bin/bd`)

Phase 2 makes all four configurable per project.

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
| bd integration | Subprocess + `--json` only. Never read `embeddeddolt/*` or write `issues.jsonl`. |
| Claude integration | `claude --print --input-format=stream-json --output-format=stream-json` per-project subprocess, resumable via stable `--session-id`. No SDK. |

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

---

## When to update this file

- After every phase closes: append a one-liner to the phase table above.
- When a hardcode is removed or a configurable replaces a literal: update the "What's already on disk" hardcodes block.
- When a new locked decision is made: add a row to the decisions table.
- When tech debt accrues or burns down: edit the deferred-work list.

When you edit the in-repo copy, also write the same change to `~/Documents/Beads/BEADS-CONTEXT.md`. The two should be byte-identical.
