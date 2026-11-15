# Holistic upgrade (0.2.1 working tree, branch `next/0.2.1`)

Written 2026-11-15. Everything below has automated evidence only (vitest,
Playwright against the mock IPC harness, `cargo test` for the Rust parts).
Nothing was checked in the packaged app: `prompts/HANDS-ON-0.2.1.md` is the
list to run there. Version files are unchanged.

## 1. What the code said before this pass

| Area | Finding | Where |
| --- | --- | --- |
| Restored agent panes | A pane that had Claude or Codex in the foreground is saved with `restored: true` and stays inert; a plain shell restarts by itself. The inert pane drew a yellow status line, the last 60 turns (only when the pane knew its session id) and two buttons, "Start new shell" and "Start shell and resume". No search, no way to continue from the keyboard | `src/state/termPanes.ts` `sanitizeNode` (about line 283); old `RestoredShell` in `src/components/TerminalPanes.tsx` |
| Session id | Claude's id came only from a hook: sessions the app started (`claude --settings`) or the opt-in install into `~/.claude/settings.json`. A `claude` typed by hand, or through an alias, had no id, so the pane fell back to the saved screen and `claude --continue` | `src/state/agentHooks.ts`, `src/lib/terminalSessions.ts:536` |
| Launch commands | Settings already had "Claude Code command" and "Codex command", but `agentStartCommand` and `agentResumeCommand` hard-coded `claude` and `codex`, so an alias was honoured by the palette launcher and ignored by resume and by the Designer Session | `src/state/agentHooks.ts:83` |
| What an upgrade loses | Nothing in storage: layouts, `hostKey`, `agentCli` and `agentSessionId` live in the web view's localStorage under the bundle id, and `PERSIST_VERSION = 2` still reads version 1. What is lost is every process, unless "Keep terminals running" is on: then the terminal host (a detached copy of the old binary) keeps the shells and the new app attaches as long as the host protocol matches (`PROTOCOL = 1`, additive only) | `src/state/termPanes.ts:279`, `src-tauri/src/pty_host.rs:34`, `:509` |
| Top bar | Seven unrelated text buttons in one row; the Designer had a second, different top bar. One launcher, for whichever provider Settings named | `src/App.tsx` (old `<header className="bs-toolbar">`), `DesignerShell.tsx` |
| Designer navigation | The current Designer view was React state inside `DesignerShell`, so nothing outside it (palette, shortcut, Terminal skin) could open History or any other view. The palette had "Switch to designer skin" only | `src/components/designer/DesignerShell.tsx` |
| Command+click | The link provider matched only `.md` / `.markdown` paths, ignored `:line`, skipped `~/` paths, and opened a file-tree tab on the *folder*. It never opened an editor. Relative paths were resolved against the pane's starting folder, not where the shell is now | `src/lib/terminalSessions.ts:257` (before), `src/lib/terminalLinks.ts` |
| Explorer "n" | Typed `nvim <path>` and Enter into whatever shell pane was active, unquoted, even if that shell was running something else | `src/components/FileTree.tsx` (before) |
| Paste | There is no clipboard plugin. Command+V is the native Edit menu's paste, which WebKit delivers to the focused element. A terminal pane that is active but whose hidden xterm input is not focused receives nothing. A real text field (the older chat panel) always works. This matches "works in chat, not in plain panes"; it is a reading of the code, not a reproduced bug | `src/lib/terminalSessions.ts:338` `handleKey`, `src-tauri/src/menu.rs` |
| Browser pane | `browser_refuses_framing` returned `false` both for "page allows framing" and for "nothing answered", so a dev server that is not running showed an empty frame. Separately, the packaged app's page is a secure custom scheme and WebKit may block a plain-http frame inside it; that cannot be seen in the harness | `src-tauri/src/browser.rs`, `src/components/BrowserPane.tsx` |
| Shelf | A working feature with no stated purpose on screen: title "Shelf", one sentence, an empty list | `src/components/designer/ShelfView.tsx` |

## 2. Decisions

### 2.1 Resume: read first, continue with Enter, automatic only as an opt-in

Options considered for "restored tabs should just work":

1. **Resume every agent pane on restore.** Forbidden by the standing rule
   (agents start on intent only, never on mount or restore). It also starts one
   process per pane for workspaces the user may not look at today.
2. **Keep the shells alive instead of resuming** ("Keep terminals running").
   This is the only option where nothing has to be resumed at all, and it
   already exists. It is opt-in and experimental, and does not cover a logout
   or restart. It remains the best answer for app updates and is the first
   thing to try in the hands-on list.
3. **Make the pane a reader, and merge the click into the first keystroke.**
   Chosen as the default. The restored pane's body is the conversation itself
   (formatted, scrollable, searchable), read from the CLI's own session file,
   which starts nothing. The message box at the bottom has the cursor when the
   pane is focused. Enter with an empty box reopens the CLI on that exact
   conversation; Enter with text reopens it and sends that text as the first
   message (`claude --resume <id> '<text>'`, `codex resume <id> '<text>'`).
   That is one explicit action, the same one the user would take anyway.
4. **An opt-in "Continue agent sessions automatically".** Built, off by
   default (Settings → Sessions). When on, a restored pane reopens its CLI when
   it is *shown*, and only when the exact conversation is known. Panes in tabs
   or workspaces that are never opened start nothing. This is a deliberate,
   user-requested exception to the launch-on-intent rule: turning the setting
   on is the standing intent. It needs the owner's sign-off before release;
   if rejected, delete `shouldAutoResumeAgents` and the one effect in
   `RestoredPane.tsx` and nothing else changes.

**Token cost.** No claim is made anywhere that reopening is free. The setting's
description says it has not been measured. `scripts/resume-cost-snapshot.mjs`
reads one session file (it starts nothing) and prints its recorded totals, so
a before/after pair around a manual resume shows whether the transcript grew.
It cannot see a request the CLI makes without writing a record; the hands-on
list says to check the CLI's own `/cost` or `/status` for the same minute.

**Session-id recovery.** Two layers:

- Live: Claude Code writes `~/.claude/sessions/<pid>.json` for each running
  session. `pty_foreground` now reads the entry for the terminal's foreground
  process (`src-tauri/src/pty.rs:603`), so a hand-typed or aliased `claude`
  gets its exact id with no hook. It is re-read at each screen checkpoint
  because `/clear` and `/resume` change it.
- After the fact: a restored pane with a CLI but no id shows the newest
  conversation of that CLI in the folder that was written before the pane's
  screen was saved and that no other pane claims
  (`src/lib/restoredSession.ts`). It is labelled "Most recent Claude
  conversation in this folder", and Continue resumes exactly the one shown.

### 2.2 One top bar, organised as places

Both skins use `src/components/TopBar.tsx`:

```
 o  [>_ Terminal] | DESIGNER  Requests  Session  History  Pinned  Bead map  Agents  Timeline | <context>      [* Claude] [>_ Codex] [+ Gemini]   <status>  [search K] [keys] [gear]
```

- The left strip is a list of places. Terminal is one; each Designer view is
  one. Any of them is one click from anywhere, so History is in the top bar in
  both skins and the Terminal ⇄ Designer switch is implicit. "DESIGNER" is a
  button that returns to the Designer view last used.
- `<context>` belongs to the current skin: the layout picker and "Show
  Explorer" icon in the Terminal, the Everyday/Heavy tier in the Designer.
- Three launchers start a CLI in a new pane beside the active one, on a click
  only. Commands come from Settings → Sessions (`claude`, `codex`, `gemini` by
  default; set them to `ccd`, `gpt`, `google` for the aliases). Claude and
  Codex also get the app's waiting signals (`agentStartCommand`). The marks are
  neutral drawings, not vendor logos.
- When "Start agents in" is set to the older chat panel, the Claude and Codex
  launchers open that panel instead, as before.
- Under 1180 px the launcher names and the palette hint hide; under 900 px the
  group label and icon hide; the strip scrolls sideways rather than wrapping.

### 2.3 Shelf becomes "Pinned"

The feature is right; the name was the problem. Nobody knows what a shelf is
for, but the History button already said "Pin". So the place is now called
**Pinned** everywhere on screen, with a purpose line ("Text, files and notes you
pinned. Type them into an agent prompt when you need them."), an empty state
that lists the three ways to fill it with a button to History, and a "Start a
session" button when there is nothing to type into. It was not merged into
History, because pinned things outlive the conversation they came from and
also come from paste and file paths. Code names (`shelf.ts`, `ShelfView`) are
unchanged. A further step (a pin button on terminal selections, drag to
reorder) is in the prompts.

### 2.4 Designer left column

The view list moved to the top bar, so the left column now lists open
workspaces (the Designer had no way to switch workspace except the palette) and
keeps the tier card. Whether that column should exist at all is an open
design question, written up as a prompt.

## 3. Keybindings

`Mod` is Command on macOS. Command/Control+P (leader) and Escape are untouched;
`bindingError` still refuses `Mod+P`.

| Action | Before | Now |
| --- | --- | --- |
| Terminal ⇄ Designer | none (palette only) | `Mod+Shift+D`, both ways |
| Designer: History | none | `Mod+Y` (the browsers' "history") |
| Designer: Requests, Session, Pinned, Bead map, Agents, Timeline | none | palette entries; unbound by default, bindable in Settings |
| Keyboard cheat sheet | leader overlay only | `Mod+/`, or the keyboard icon |
| Focus pane left / down / up / right | `Mod+Shift+Arrow` | also `Mod+Shift+H/J/K/L` |
| Browser pane | `Mod+Shift+L` | `Mod+Shift+B` (L is now "pane right"; the old default is in `RETIRED_DEFAULTS`, so a saved copy moves by itself) |
| Start Gemini | none | palette entry and top bar |
| Workspaces 1-9, terminal tabs, splits, zoom, fullscreen | unchanged | unchanged |

Considered and left for later: a `g`-prefixed leader layer for views (`Space g
h` for History), which needs changes inside `useVimNav`.

Palette (`Mod+K`): the root list now also finds other workspaces, the terminal
tabs of this workspace (by number, program and folder) and the 15 most recent
conversations of the folder (opens that one in History). The session list is
read when the palette opens; reading it starts nothing.

## 4. What was implemented

| # | Item | Files | Tests |
| --- | --- | --- | --- |
| 1 | Restored pane is a searchable conversation with a message box; Enter continues; "New shell"; saved screen one click away | `src/components/RestoredPane.tsx`, `TerminalPanes.tsx`, `TerminalPanes.css` | `TerminalPanes.test.tsx`, `tests/live/holistic-upgrade.spec.ts` |
| 1 | Resume carries a typed message; resume and start use the configured command | `src/state/agentHooks.ts`, `src/state/termPanes.ts:871` | same, `agentHooks.test.ts` |
| 1 | Claude session id from Claude's own registry; conversation recovery for panes with no id | `src-tauri/src/pty.rs`, `src/lib/terminalSessions.ts`, `src/lib/restoredSession.ts` | `cargo test pty::`, `restoredSession.test.ts` |
| 1 | Opt-in "Continue agent sessions automatically" | `src/state/sessionPreferences.ts`, `SettingsPanel.tsx`, `RestoredPane.tsx` | unit and live |
| 1 | Read-only cost snapshot script | `scripts/resume-cost-snapshot.mjs` | run once against a local session file |
| 2 | Shared top bar, three launchers, Gemini command setting | `src/components/TopBar.tsx`, `App.tsx`, `DesignerShell.tsx`, `CommandPalette.css` | live |
| 3 | Designer view store; top-bar places; palette entries for views, workspaces, tabs, conversations; new shortcuts; cheat sheet | `src/state/designerNav.ts`, `src/state/commands.ts`, `CommandPalette.tsx`, `ShortcutSheet.tsx` | `commands.test.ts`, live |
| 4 | Command+click on `path`, `path:line`, `path:line:col`, `~/path`, any common file type: opens in the editor, reusing an nvim already in the foreground of a pane in this tab (checked first), else a new split | `src/lib/terminalLinks.ts`, `src/lib/openInEditor.ts`, `terminalSessions.ts:257`, `pty.rs:519` (foreground program and folder), `pty_host.rs` | `terminalLinks.test.ts`, `cargo test pty::` |
| 5 | Purpose line on every Designer view; Pinned rename and empty state; History opens on the newest conversation, has a real empty state; conversation look (your messages as cards on the right, agent prose on the left, times, agent name) | `DesignerShell.tsx`, `ShelfView.tsx`, `HistoryView.tsx`, `ConversationView.tsx` | `designer-desk.spec.ts`, `holistic-upgrade.spec.ts` |
| 7 | Open in editor from the Explorer (`n`), History "Changed" chips, Session changed files; "Editor command" setting | `FileTree.tsx`, `ConversationView.tsx`, `SessionView.tsx`, `sessionPreferences.ts` | covered through `openInEditor` helpers only |
| 8 | Paste with no focused field goes to the active terminal pane | `terminalSessions.ts:887` | `terminalSessions.test.ts` |
| 8 | Browser pane says "Nothing is answering at …" for a dead address and offers a window when a plain-http page may be blocked | `browser.rs:83`, `BrowserPane.tsx` | `browser-pane.spec.ts`, `BrowserPane.test.ts` |

Existing specs that changed only because labels moved: `settings.spec.ts`,
`pane-notifications.spec.ts`, `conductor-control.spec.ts`,
`demo-hardening.spec.ts`, `designer-desk.spec.ts`, `readme-shots.spec.ts`
(the README screenshots need regenerating before a release).

## 5. Not verified

- Everything native: real PTY, WKWebView focus and paste, the terminal host,
  `~/.claude/sessions` on other Claude Code versions (seen on 2.1.x only).
- `claude --resume <id> '<prompt>'` and `codex resume <id> … '<prompt>'` were
  not run against a provider. With an alias that already contains a
  subcommand or a prompt, the composed line may be wrong.
- Reusing a running nvim types `Esc :edit <path> Enter`. It was tested as a
  string, not against nvim. A buffer with unsaved changes and `nohidden` will
  refuse the `:edit`.
- Whether a plain-http frame is really blocked in the packaged app.
- The paste fix addresses a cause found by reading; the user's report was not
  reproduced.
- Final automated gate, run once at the end of the session: `npm run build`, vitest 352 passed in 58 files, Playwright 118 passed and 7 skipped, `cargo test` 174 passed and 2 ignored, `git diff --check` clean.

## 6. What remains

One prompt file per item in `docs/roadmap-0.2/prompts/` (priority on the first
line). Short list:

- p1: hands-on pass; sign-off on the automatic-continue setting.
- p2: restored agent *chat* panes (the older JSON chat) still show the grey
  "Saved Claude session" card; split reflow ("shifted words"); workspace tab
  overflow; Designer Session learning its session id; native browser web view.
- p3: leader layer for views; Designer left column; pin from a terminal
  selection; "path shows hex"; saved-screen last line; per-day Codex usage;
  Gemini history.
- p4: paper theme for conversations; README screenshots and release notes.
