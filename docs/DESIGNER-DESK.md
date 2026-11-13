# Designer Desk — making the Designer worth opening for a terminal person

Epic `Code-05b`. Todoist: Designer View → "make Design view daily-driver".

## The problem, stated honestly

A developer who loves terminals will never choose a GUI to *do* what the terminal
already does faster: type to an agent, switch panes, run commands. Every
"Designer is a friendlier terminal" idea loses to `Cmd+K` and muscle memory.

So the Designer must stop competing with the terminal and start **feeding off
it**. The terminal is where you act. The Designer is where you **read, gather,
compare and decide**: things a character grid is bad at. If it only shows
what the terminals are already doing, in a form that is nicer to read than the
scrollback, there is a reason to glance at it, and no cost to switching back.

## What the research says

| Tool | What it gets right | Take for Beads Station |
| --- | --- | --- |
| Codex app / Claude Desktop (Code tab) | Review queue, worktrees per task, automations, skills UI | Review gate already exists (capture → approve). Worktrees and automations are larger; keep as future |
| Conductor / Vibe Kanban | Diff-first review, many agents in a dashboard | Our Changes panel and Bead map cover this; History adds the "what did it actually do" view |
| CodexBar (steipete) | Usage as a quiet glanceable meter: burn rate vs even pace, reset countdowns, labelled-incomplete data, opt-in privacy | Codex rollouts already contain `rate_limits` in `token_count` events and Claude's JSONL has per-message usage. A local-only meter needs no cookies or API |
| opencode | Same session reachable from TUI, desktop and a web link (`pair`: short-lived one-time link) | The model for the phone idea: one session, several windows onto it |
| pi | Session tree: fork and navigate branches; deliberately skips sub-agents and plan mode | Claude's JSONL has `parentUuid`, so branches are recoverable. A tree view is a future History mode |
| Napkin (your app) | Real CLI in a PTY plus an "ink spill" of changed files | Already ported as Session. The missing half was *remembering*: Napkin is disposable by design, Beads Station should not forget |

The common thread: the winners **do not reimplement the agent**. They observe
it (files, hooks, logs) and add a surface. That is also this repo's rule.

## Ranked ideas

1. **Transcripts (History).** Read any past or running Claude/Codex session as a
   formatted conversation, without resuming it. Built. This is the biggest daily
   reason to open the Designer: the terminal scrollback is gone after a
   restart, the session file is not.
2. **Shelf.** One tray for context (paste, file, markdown note, Obsidian path)
   that can be typed into *any* running agent. Built. This is the "connect
   anything without waiting for qwen/pulse" answer: it needs no integration
   because it only types into a terminal, and it never presses Enter.
3. **Meter.** CodexBar-style, local only: Codex 5 h / weekly windows against an
   even pace, Claude output per day, per-session token line. Built.
4. **Bead ↔ session links.** A ticket lists the sessions whose opening prompt
   names it and opens them in History. Built (matching by id, no hooks).
5. **Session tree.** Fork points from `parentUuid`; resume from a branch. Later.
6. **Phone view over Tailscale.** Read-only transcripts, waiting panes and
   approve/deny, from a tiny server bound to the tailnet interface only (opencode's
   `pair` flow is the pattern: one-time link, short expiry). Needs a threat
   model first. Later.
7. **Automations / worktree-per-ticket** (Codex app). Large; only after the
   durable lease work in `Code-yfb`.

Rejected: embedding a second chat UI that talks to the model itself (hidden
turns, duplicate auth), a cloud account, and any feature that launches an agent
on mount.

## What shipped in this slice

- `src-tauri/src/transcripts.rs`: `transcripts_list`, `transcript_read`.
  Read-only; the page names a session by (provider, id) and the id is matched
  against files the backend listed itself, so it cannot read an arbitrary path.
  Reads are bounded (newest 8 MB parsed, 256 KB heads for titles). Sidechain
  (sub-agent) records are skipped, repeated assistant usage lines are counted
  once per message, and Codex preamble (environment/AGENTS) is not shown as a
  prompt.
- Designer **History** (`HistoryView.tsx`): session list, formatted turns
  (sanitized markdown), collapsed tool calls with results, edited files per turn,
  search, Top/Latest, "Pin to Shelf" per turn, explicit **Resume in Session**
  (disabled while a session is already running; resumes the exact session id,
  never "the last one").
- Designer **Shelf** (`ShelfView.tsx`, `shelf.ts`): one input that classifies
  text vs file vs markdown path; items per workspace; type into the Designer
  session or the active terminal pane, or copy. Typing never submits.

Answers the open 0.1.8 bug "Resume old codex/claude chat view too bland / can't
scroll formatted chat without resuming" for the Designer side. The in-terminal
resume chat view (`ClaudeChat`) is unchanged.

## Limits and honesty

- Shelf items live in browser storage per workspace: a convenience, not durable
  config, and not synced.
- Session usage is read for both CLIs: Claude from per-message usage, Codex from the last running `total_token_usage` (its cached input is split out). It is per session, shown in History and as a small chip on a live agent pane in the Terminal view. A session with no record says "Usage not recorded" rather than guessing. No dollar figures: unknown stays unknown.
- Pasting multi-line text into a *plain shell* that does not use bracketed paste
  would run lines as it receives them. Agent TUIs and zsh/bash with bracketed
  paste are fine; the Shelf uses the same paste path as "Paste ticket into session".
- Claude's `~/.claude/projects` folder naming (non-alphanumerics → `-`) and the
  JSONL record shapes are the CLIs' own, undocumented formats; the parser skips
  what it does not recognise instead of failing.

## Hands-on checklist (packaged app; not run in this session)

1. Designer → History: sessions for the open folder appear, newest first; a
   running Claude session shows new turns within ~10 s.
2. Open a large old session: it opens at the end, "Show earlier turns" works,
   Top/Latest work, scrolling up stops it following new turns.
3. Search narrows turns; tool rows expand to results; "Pin to Shelf" appears
   in Shelf.
4. **Resume in Session** on a Claude and a Codex session: the CLI starts and the
   conversation is the one you picked. The button is disabled while a Session
   is running.
5. Shelf: add text, a `~/…/note.md` path (note appears as text), a file path;
   with a Session running, "Type N into designer session" types the text and
   does not press Enter. Select "Active terminal pane" in a normal terminal.
6. Usage card (History, bottom left): Codex windows and the 7-day bars look right next to your real usage; a window that already reset reads "reset since last reading".
7. A ticket you ran through "Open in a live session" lists that session under "Sessions on this ticket".
8. Opening History or Shelf starts no process (Activity Monitor: no new `claude`/`codex`).
