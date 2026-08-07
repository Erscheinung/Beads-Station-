# Beads-Station — Project Instructions for AI Agents

This project uses **bd (beads)** for task and issue tracking. The bd workspace lives at `.beads/` in this directory (it used to live at `~/Code/.beads/` — that location is gone now; do not look there).

## Task Tracking

- Use `bd` for ALL task tracking — do NOT use TaskCreate, TodoWrite, or markdown TODO lists
- Run `bd prime` for the full workflow primer (it auto-runs on session start via the SessionStart hook in `.claude/settings.json`)
- Use `bd remember "<insight>"` for persistent knowledge across sessions

### Quick Reference

```bash
bd ready              # Find available work (no blockers)
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Mark complete
bd list --status=in_progress  # See active work
```

### Rules

- Create a bd issue BEFORE writing code; mark `in_progress` when starting
- Close issues with `bd close <id1> <id2> ...` when done — batch when possible
- Priority is 0–4 or P0–P4 (0=critical, 2=medium, 4=backlog) — NOT "high/medium/low"
- Do NOT run `bd edit` — it opens `$EDITOR` and blocks the agent. Use `bd update <id> --notes/--design/--description` instead

### bd persistence preflight (MANDATORY first action of any session)

bd reads `git config beads.role` from the **process cwd**. If unset, `bd create`/`bd update`/`bd close`/`bd note` print a `✓` line and silently drop the write. This caused a multi-issue data-loss event on 2026-06-12 — see BEADS-CONTEXT.md for the full post-mortem.

Run this BEFORE any bd write:

```bash
cd ~/Code/Beads-Station
git config --get beads.role   # MUST output 'maintainer' — if empty, run: git config beads.role maintainer
bd where                      # MUST resolve to ~/Code/Beads-Station/.beads
```

Always run bd commands from inside this repo (`~/Code/Beads-Station`). Do NOT use bd's `-C` flag — it doesn't fix the role-check cwd quirk. `cd` first, then run bare bd.

### Architecture

Issue data lives in a local Dolt DB at `.beads/embeddeddolt/`. The DB itself is gitignored via `.beads/.gitignore` (the bd installer wrote that file — don't fight it). `.beads/issues.jsonl` is the passive export and **is** committed alongside code changes so the export tracks reality.

Phase tickets actually live in `~/.beads-planning/.beads/` — bd here uses the federated-repo model, with `repos.primary: "."` and `repos.additional: [~/.beads-planning]` configured in `.beads/config.yaml`. That means `bd ready` from this repo sees both local issues and the planning repo's tickets. Most Beads-Station phase work is in the planning repo (it survives a delete of this repo's `.beads/`).

This repo has a remote at `origin = https://remote.example/Beads-Station.git`. Code commits push there; bd data does not (planning repo has no remote).

## Session Completion

**When ending a work session**, complete every step. Work is NOT done until `git push` succeeds.

1. Close completed issues: `bd close <id1> <id2> ...`
2. Run quality gates (tests, linters, builds) if code changed:
   ```bash
   npm run build                              # tsc + vite (also runs the audit-emoji gate)
   npm test                                   # vitest unit suite
   npm run test:live                          # R12 Playwright live-verify (drives Chrome vs vite+mockIPC)
   cargo check --manifest-path src-tauri/Cargo.toml --quiet
   ```
   `test:live` is the frontend live gate (focus/keydown/pane/a-d) that headless
   vitest can't reach. It auto-starts vite in VITE_LIVE_MOCK mode; needs the
   Playwright chromium browser (`npx playwright install chromium` once). It does
   NOT cover WKWebView/the real Rust backend (macOS has no WebKitWebDriver).
3. Update both BEADS-CONTEXT.md copies (in-repo + Obsidian mirror at `~/Documents/Beads/BEADS-CONTEXT.md`); they should be byte-identical
4. Append a `## HH:MM — <what shipped>` subsection to `~/Documents/Beads/Daily/{YYYY-MM-DD}.md`
5. Commit + push:
   ```bash
   git pull --rebase
   git push
   git status   # MUST show "up to date with origin"
   ```
6. Hand off context: state what closed, what's newly ready, what the next agent should pick up
