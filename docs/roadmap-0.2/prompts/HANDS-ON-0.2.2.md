# [p1] Hands-on checklist for 0.2.2

Nothing below was checked in the packaged app. The automated tests use a mock
IPC layer in Chromium: they do not prove a real PTY, WKWebView focus, paste,
the terminal host or any of the three CLIs. Build or install a test copy (never
over an app you are working in; a test copy still writes to the real
app-support folder), then tick each line or write what happened instead.

Use your own commands in Settings → Sessions: Claude `ccd`, Codex `gpt`,
Gemini `google`.

## A. Usage chip and status bar (Code-7xc.1)

- [ ] In a pane running Claude, the chip shows context percent and tokens, and
      the status bar shows "Claude 5h NN% · resets HH:MM". Compare with
      `/status` (Claude) and `/status` (Codex): the numbers match within a few
      percent. Gemini shows what its session file reports; anything unknown
      says so instead of showing 0.
- [ ] Hand-typed `claude`: before pressing Add in Settings → Sessions → hooks,
      no live limits; after pressing Add again (re-Add) and starting a new
      `claude`, the chip appears. Your own status line, if you had one, still
      works.
- [ ] Designer History and Session show the same usage for a session.

## B. Handoff note and prompt journal (Code-7xc.2)

- [ ] Push a Claude session to 95% context (or use a small window): a toast
      "Handoff saved: …-claude.md" appears once, "Open in Pinned" opens it. The
      file lists the task, checklist and the exact resume command, contains no
      absolute home path, and nothing was sent to a model.
- [ ] Submit a few prompts in an agent pane: they are journaled. A plain shell
      pane is never journaled.

## C. Notification sounds (Code-7xc.7)

- [ ] Settings → Notifications: pick a sound for waiting, responded and
      subagent finished; Preview plays it. A real Claude turn that ends or asks
      for permission plays the right one; a subagent stop plays the subagent
      one (needs the SubagentStop hook, so re-Add hooks). Off means silent.

## D. Find (Code-7xc.3)

- [ ] Cmd+F in a plain shell pane: bar opens, matches highlighted, Enter and
      Shift+Enter step, Escape closes and returns to the terminal; nothing is
      typed into the shell.
- [ ] Cmd+F inside nvim and inside Claude/Codex: the app bar opens (nvim's own
      `/` still works); Escape does not leak into the editor.
- [ ] Cmd+Shift+F searches all panes in the workspace; selecting a result
      focuses that pane at the line.
- [ ] A restored agent pane and History highlight matches in place.

## E. Bring in a terminal (Code-7xc.4)

- [ ] Start `ccd`, `gpt` and `google` in an outside terminal (Terminal.app,
      iTerm2, Ghostty). "Bring in a terminal…" lists each, and adopting opens a
      split that continues that exact conversation.
- [ ] Proxy-icon drag from the title bar of Terminal, iTerm2 and Ghostty onto a
      pane (also with Option held) brings the terminal's folder in.
- [ ] A tmux session started outside the app: attach shows the live screen and
      typing works; closing the pane detaches without killing tmux.
- [ ] Dropping a Finder folder on a pane opens it as intended.

## F. Scrolling (Code-7xc.5)

- [ ] Gemini CLI: scroll up with the trackpad while it streams; the view stays
      put and Shift+wheel moves scrollback.
- [ ] Scroll up in a long Claude/Codex output, switch tab and back: the view is
      where you left it and the next wheel moves from there.
- [ ] No repeated text while scrolling during streaming.

## G. Themes and typed-command colour (Code-7xc.6)

- [ ] Each of the 8 new themes: text readable, light/dark chrome correct.
- [ ] Settings → Appearance → Match system appearance follows macOS Light/Dark
      live.
- [ ] Toggle theme cycles every theme, in order and shuffled (no repeat until
      all were seen).
- [ ] Typed-command colour: the command line you type has its own colour in a
      new zsh pane. Shell startup is intact: your `.zshrc`, prompt, aliases,
      completions, `$ZDOTDIR` and plugin managers behave as before; turn the
      setting off and a new pane starts without the shim.

## H. Bug batch (Code-7xc.8)

- [ ] Saved screen after a restart wraps to the pane width, no sideways
      scroll, the last line is clear of the scrollbar.
- [ ] Dragging a path with spaces or `%20` from Finder pastes it once decoded.
- [ ] Workspace picker, update note and Pinned tooltips show `~`, not the home
      path.
- [ ] A folder without a Beads database shows the setup hint; "Don't show for
      this folder" hides it for that folder only.
- [ ] Many workspace tabs: the count chevron opens a menu of all of them.

## I. Dictation, paste, restored chat panes and History (Code-7xc.8, 7xc.9)

- [ ] Voice typing (macOS dictation, Fn twice) into a plain shell: as the spoken
      text passes the right edge of the pane the window does not scroll
      sideways; the line wraps. Also type with an IME (e.g. Japanese Hiragana)
      and confirm composition still commits normally.
- [ ] Paste fallback (Code-7xc.8): copy text from Safari/Notes, click a pane
      header, press Command+V: the text appears once, at the prompt, within
      about 0.1 s. Copy rich text (a web page selection): plain text appears.
      Copying a file in Finder pastes its name only (the native fallback reads
      text, not file references; Finder drops still paste quoted paths).
- [ ] Restored chat pane (Code-7xc.9): quit with a "New Claude agent pane" open,
      relaunch. The pane shows the conversation (searchable) with Continue and
      Start new session; Enter on the focused Continue reopens the same Claude
      conversation. A chat that never recorded an id shows the plain card.
- [ ] History (Code-7xc.9): with a Session running, "Go to running session" and
      "Resume in a new pane" (a split in the folder running the resume command);
      the "New turns" pill and "running" dot while a real session writes; "Fork
      here" opens a split running `claude --resume <id> --fork-session` (and
      `codex fork <id>`), a new session id appears in History afterwards.

## Results

Write the date, the build, and one line per failed item here.
