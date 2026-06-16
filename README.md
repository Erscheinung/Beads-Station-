# Beads Station

A single-user macOS desktop app for managing [bd (beads)](https://github.com/gastownhall/beads) issue trackers across the projects under `~/Code/`. Sidebar lists every project as a tab; main pane is a Jira-style 4-column drag-drop board (Ready / In Progress / Blocked / Done) plus a hierarchical issue tree; bottom strip is a per-project Claude CLI chat (resumable across sessions); a collapsible terminal sits over the working directory of the active project.

**Status:** Phase 5 of 10 shipped (issue tree + indent guides + devicons). Phases 6, 7, 8, 9 are queued; phase 10 is signed-dmg polish.

![tauri](https://img.shields.io/badge/Tauri-2-blue) ![rust](https://img.shields.io/badge/Rust-1.90.0-orange) ![react](https://img.shields.io/badge/React-19-green) ![macOS](https://img.shields.io/badge/macOS-aarch64-lightgrey)

## What it does today

- **Project picker** — scans `~/Code/`, plus extras configured in bd's `repos.additional`; shows each as a tab in a bufferline-style strip with a "has-bd" dot.
- **Per-project Claude session** — the bottom chat pane talks to the local `claude` CLI with a stable `--session-id` per project, so closing the app and reopening replays the conversation. Gateway-routed via `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` from a gitignored `.env` at the repo root.
- **Issue board** — 4 columns, drag-drop with optimistic UI + rollback toast. Cards show priority bar (P1 red / P2 yellow / P3 blue), id, title, label chips. Live-updates in 250ms when bd writes happen externally (FSEvents on `<repo>/.beads/`).
- **Issue tree** — sidebar groups by project → status → parent, with 1px hairline indent guides (lit on the cursor's ancestor branch), codicon chevrons, devicons per issue type (rocket = epic, sparkle = feature, checklist = task, bug = bug, tools = chore), 6px status dots, and a yellow ring on open issues that have downstream dependents.
- **Vim modal navigation** — `Space` is the leader (1s window). `<leader>p/b/c/s/q` cycle project / focus board / focus chat / focus sidebar / quit. In sidebar: `j`/`k` move cursor, `h`/`l` collapse/expand, `Enter`/`o` open issue, `gg`/`G` first/last row, `zR`/`zM` expand-all/collapse-all. `INPUT`/`TEXTAREA`/`xterm`/`ProseMirror` always bypass.
- **LazyVim aesthetic** — tokyonight Storm token set, 1px gap CSS grid, lualine-style statusline, ANSI-Shadow `BEADS` empty-state dashboard, which-key overlay, JetBrains Mono everywhere. Locked rule: purple is for syntax constructs only, never as a primary surface; `--bs-blue` is the dominant accent.

## Install

```bash
open artifacts/Beads-Station.dmg
# drag to /Applications
# right-click "Beads Station" in /Applications → Open → confirm Gatekeeper warning ONCE
# subsequent launches work normally
```

The dmg is unsigned and aarch64-only (Apple Silicon). Code signing + universal binary land in Phase 10.

## Build from source

```bash
git clone https://remote.example/Beads-Station.git
cd Beads-Station
cp .env.example .env             # fill in ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL for Gateway
npm install
source ~/.cargo/env              # if cargo isn't already on PATH
npm run tauri build
cp 'src-tauri/target/release/bundle/dmg/Beads Station_0.1.0_aarch64.dmg' artifacts/Beads-Station.dmg
```

For dev (hot-reload):

```bash
npm run tauri dev
```

The frontend `predev`/`prebuild` hooks run `scripts/audit-emoji.mjs`, which fails the build if any emoji glyphs land in JSX text (Codicons via the `codicon` font are fine; literal emoji are not).

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Tauri 2 shell (Rust 1.90.0, target aarch64-apple-darwin)                    │
│                                                                              │
│  src-tauri/src/                                                              │
│    lib.rs        — registers ~25 Tauri commands; loads plugin-store +        │
│                    .env at startup                                           │
│    projects.rs   — scans ~/Code/, persists per-project session UUIDs         │
│    claude.rs     — per-project Claude CLI subprocess (HashMap), event        │
│                    stream namespaced as claude_event:{projectId}             │
│    pty.rs        — portable-pty bindings for the embedded terminal           │
│    bd.rs         — subprocess bridge to bd CLI; reads (--json) and writes    │
│                    via current_dir(repo_path) (NOT -C)                       │
│    watcher.rs    — macOS FSEvents on .beads/ → bd_changed event              │
│    binresolve.rs — canonical-dir-first resolver for bd / claude              │
│    envloader.rs  — KEY=value parser; sets process env at startup             │
└──────────────────────────────────────────────────────────────────────────────┘
                                      ↕  invoke / event
┌──────────────────────────────────────────────────────────────────────────────┐
│  React 19 + Vite 7 + TypeScript                                              │
│                                                                              │
│  src/                                                                        │
│    App.tsx               — outer 2-col grid: sidebar (320px) + main pane     │
│                            (TabBar + Board + Terminal stack); bottom strip   │
│                            = ClaudeChat; statusline below                    │
│    components/                                                               │
│      IssueList.tsx       — sidebar wrapper: bdList + useBdLive + buildTree   │
│                            + useTreeNav + IssueTree                          │
│      IssueTree.tsx       — tree visual primitive (P5)                        │
│      Board.tsx           — 4-column drag-drop (dnd-kit)                      │
│      Card.tsx            — priority bar + tokyonight token usage             │
│      ClaudeChat.tsx      — per-project chat, status dot, raw-event drawer    │
│      TabBar.tsx          — bufferline strip with diagonal slash separator    │
│      Terminal.tsx        — xterm.js bound to a per-project PTY               │
│      Statusline.tsx      — lualine: mode | path | branch | counts | clock    │
│      Dashboard.tsx       — empty-state (ANSI-Shadow BEADS ASCII)             │
│      WhichKey.tsx        — leader-overlay                                    │
│    hooks/                                                                    │
│      useBdLive.ts        — listens bd_changed:{repoPath} (debounced)         │
│      useTreeNav.ts       — sidebar cursor + expand state                     │
│      useVimNav.ts        — global window keymap (modal)                      │
│    state/                                                                    │
│      projects.ts         — useProjects() + activeId in localStorage          │
│      tree.ts             — pure tree shaping (no React)                      │
│      projectLabel.ts     — label resolver                                    │
│      vim.ts              — useSyncExternalStore-backed mode/focus store      │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Locked design decisions

| Decision                  | Choice                                                                 |
|---------------------------|------------------------------------------------------------------------|
| Aesthetic                 | LazyVim *patterns* ported to web (Lua → TS); not a code port           |
| Color palette             | tokyonight Storm; `--bs-blue` dominant, purple is syntax-only          |
| Default Claude permission | `acceptEdits`; per-project override lands in Phase 6                   |
| Multi-project model       | Federated bd: per-repo `.beads/` + `~/.beads-planning/` shared planning |
| Daily file shape          | `/Documents/Beads/Daily/{YYYY-MM-DD}.md`, append `## HH:MM`        |
| Packaging                 | macOS only for v1                                                      |
| bd integration            | Subprocess + `--json`; never read `embeddeddolt/`, never write JSONL   |
| Claude integration        | `claude --print --input-format=stream-json --output-format=stream-json`|

### File-on-disk hardcodes (deliberately deferred)

- `~/.local/bin/claude` is a fallback for the Claude binary; canonical-dir resolver checks first
- `~/Code/` as project scan root; `repos.additional` in bd's config can extend it
- aarch64 dmg only (Phase 10 will add `--target universal-apple-darwin`)
- bd data does not sync to a remote (planning repo has no remote)

## Issue tracking

This project uses **bd (beads)** internally to track its own roadmap. The bd workspace is at `.beads/` in this repo and federates with `~/.beads-planning/`, where the actual phase tickets live.

```bash
git config beads.role maintainer    # one-time, prevents silent write loss
bd ready                            # see what's next
bd show Code-ky4.6                  # next phase: Claude tool surface
```

See `CLAUDE.md` for AI-agent-specific workflow and `BEADS-CONTEXT.md` for the canonical phase plan and recovery context.

## License

Internal / personal use. Not packaged for redistribution.
