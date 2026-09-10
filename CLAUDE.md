# Beads Station — agent workflow

Read `AGENTS.md` first for product constraints and `docs/ASTRA-DAILY-DRIVER-PLAN.md` for the roadmap. Follow the current user's scope. Earlier absolute paths and phase-completion claims in `BEADS-CONTEXT.md` describe a different machine.

## Before tracker writes

Run these from this repository's actual working directory:

```sh
git config --get beads.role # must be maintainer; set it if absent
bd where                   # must resolve to this repo's .beads
bd prime
```

Use `bd` for implementation tracking. Create or reconcile an issue before code changes, claim it, and read it back to verify persistence. Use `bd update`, not interactive `bd edit`. Do not edit Dolt files or passive JSONL exports directly. The old `~/.beads-planning` federation was removed on this machine; reintroduce additional repositories only with valid local paths.

```sh
bd ready
bd show <id>
bd update <id> --claim
bd close <id> --reason 'Implemented and verified ...'
```

## Verification and handoff

Run the relevant tests and the gates in README.md when implementation changes. Chromium + mock IPC tests do not establish native PTY or authentication correctness. Record native evidence separately and distinguish live process survival from saved-layout restoration.

Preserve pre-existing user changes. Do not create the previous laptop's Obsidian mirror or daily folders. Do not push an ephemeral branch without authorization. End with changed behavior, checks actually run, remaining limitations, and a concrete next step. Keep `AGENTS.md` current; historical plans and notes should not override current source or user instructions.
