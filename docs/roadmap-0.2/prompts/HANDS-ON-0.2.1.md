# [p1] Hands-on checklist for the 0.2.1 working tree

Nothing below was checked in the packaged app. The automated tests use a
mock IPC layer in Chromium: they do not prove a real PTY, WKWebView focus,
paste, the terminal host or either CLI. Build a test copy (do not install over
the app you are working in; a test copy still writes to the real app-support
folder), then tick each line or write what happened instead.

Before starting, set your own commands in Settings → Sessions: Claude Code
command `ccd`, Codex command `gpt`, Gemini command `google`, Editor command
`nvim`.

## A. Restored panes (the main change)

1. In a terminal pane type your Claude alias by hand, send one message, wait
   for the answer. Do the same with Codex in a second pane. Leave a third pane
   as a plain shell. Quit the app and open it again.
   - [ ] The plain shell starts by itself.
   - [ ] The Claude pane shows the conversation (your message as a card on the
         right, the answer on the left), headed "This pane's conversation".
         If it says "Most recent Claude conversation in this folder" instead,
         the live id lookup (`~/.claude/sessions/<pid>.json`) did not work for
         your Claude Code version: note the version.
   - [ ] The Codex pane shows its conversation the same way.
   - [ ] Activity Monitor: no `claude` or `codex` process exists yet.
2. In the restored Claude pane:
   - [ ] It scrolls with the trackpad and with Page Up/Down after a click in it.
   - [ ] Search narrows the turns; clearing it brings them back.
   - [ ] "Show saved screen" shows the old screen, and its last line is fully
         visible when scrolled to the end.
   - [ ] Click the pane: the message box has the cursor. Press Enter with the
         box empty: a shell starts and the CLI reopens *that* conversation.
3. In the restored Codex pane type "what was the last thing you did?" and
   press Enter.
   - [ ] Codex reopens the conversation and that message is sent once.
   - [ ] A message with an apostrophe and a `$HOME` in it arrives as typed.
4. A pane where the CLI had already exited before you quit:
   - [ ] It restarts as a plain shell, with no conversation offered.
5. Escape and Command+P in the message box:
   - [ ] Escape leaves the box; Command+P then a leader key still works.
6. Upgrade path: install this build over a 0.2.0 copy that has saved agent panes.
   - [ ] Layout, tabs and workspaces are all there.
   - [ ] Agent panes saved by 0.2.0 without an id show "Most recent …
         conversation in this folder", and it is the right one.

## B. Automatic continue (opt-in) and its cost

1. Settings → Sessions → turn on "Continue agent sessions automatically". Quit
   with two agent panes in the visible tab and one in another tab. Reopen.
   - [ ] The two visible panes reopen their CLIs without a click.
   - [ ] The pane in the other tab starts only when you switch to that tab.
   - [ ] A pane whose conversation is not known does not start by itself.
2. Cost of reopening, before any message:
   - [ ] `node scripts/resume-cost-snapshot.mjs claude <id>` before; resume,
         wait 30 seconds, send nothing, quit the CLI; run it again. Write both
         outputs here, and what `/cost` shows.
   - [ ] The same for Codex with `/status`.
3. Turn the setting off again unless you decide to keep it.

## C. Kept terminals across an update

1. Settings → Sessions → "Keep terminals running when Beads Station quits".
   Start Claude in a new pane, quit, reopen.
   - [ ] The pane reattaches to the running CLI with its history; no
         conversation view, no Continue.
2. With that still on, update from the previous build to this one.
   - [ ] Panes reattach after the update (old host, new app).
   - [ ] Command+click on a relative path in a reattached pane still opens the
         file (an old host does not report the folder; the pane's starting
         folder is used instead).

## D. Top bar and launchers

- [ ] The bar reads: mark, Terminal, DESIGNER, the seven views, the layout
      picker, three launchers, search, keyboard, gear. Nothing wraps at your
      usual window width; narrow the window and the launcher names hide.
- [ ] Each launcher opens a new pane beside the active one and types your
      alias (`ccd`, `gpt`, `google`). Nothing starts until the click.
- [ ] With "Start agents in: Chat panel", Claude and Codex open the bottom
      panel instead and Gemini still opens a pane.
- [ ] Opening the app, switching workspace and switching skin start no agent.

## E. Getting around

- [ ] Command+Shift+D flips Terminal and Designer, from a focused terminal
      (including inside nvim and inside Claude) and from the Designer. Coming
      back, the terminal has the cursor.
- [ ] Command+Y opens History from a focused terminal.
- [ ] Clicking History in the top bar from the Terminal opens the newest
      conversation; no process starts.
- [ ] Command+Shift+H/J/K/L move between split panes, including from inside
      nvim. Command+Shift+B opens a browser pane (it used to be L).
- [ ] If you had rebound shortcuts in 0.2.0, your own bindings are unchanged.
- [ ] Command+/ shows the cheat sheet; Escape closes it and does not reach
      the terminal.
- [ ] Command+K: type part of a workspace name, "tab 2", "history", "pinned",
      and a few words of an old conversation title. Each opens the right thing.

## F. Command+click and the editor

- [ ] `ls docs/*.md`, then Command+click a file name: nvim opens it in a new
      split in the same workspace.
- [ ] With that nvim still open, Command+click another path: the same nvim
      shows the new file (no second split).
- [ ] Run a failing `cargo check` or `tsc`, Command+click `src/x.rs:12:5`:
      the cursor lands on line 12, column 5.
- [ ] `cd` into a subfolder, print a relative path, Command+click it: the
      right file opens (the shell's current folder is used).
- [ ] A path with a space (`ls "My Notes/a.md"`) opens; a `~/…` path opens.
- [ ] Command+click while nvim is in insert mode with unsaved changes: say
      what happened (expected: it leaves insert mode and `:edit` runs or is
      refused with E37; nothing is typed into the buffer).
- [ ] Command+click inside a Claude pane on a path it printed: the file opens
      in a split and nothing is typed into Claude.
- [ ] Explorer pane, `n` on a file: opens in the editor the same way.
- [ ] History → a "Changed:" file chip, and Session → a changed file → "Open
      in editor": both switch to the Terminal and open the file.

## G. Designer

- [ ] Every view has one grey purpose line under the top bar that makes sense
      to you without explanation. Write down any that do not.
- [ ] Pinned: the empty state tells you what to do; pin an answer from
      History; "Type 1 into designer session" types it and does not press Enter.
- [ ] History: your messages sit on the right, answers on the left, times
      are right, tool calls fold.
- [ ] The left column lists your open workspaces and switches between them.

## H. Bug fixes to confirm

- [ ] Copy text in another app. Click a terminal pane's header (not the text
      area), press Command+V: the text appears at the prompt and is not run.
- [ ] Paste into a plain shell after switching back from another app with
      Command+Tab, without clicking first.
- [ ] Paste still works normally inside Claude, Codex and nvim, and is not
      pasted twice anywhere.
- [ ] Browser pane, `localhost:<port>` with no server: it says "Nothing is
      answering at …". Start the server, Reload: the page shows. If it stays
      blank with the server running, press "Open it in a window" and note it
      (that confirms `06-native-browser-view.md` is needed).

## Results

Write the date, the build, and one line per failed item here.
