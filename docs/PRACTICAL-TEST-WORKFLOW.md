# Practical Beads Station test workflow

Prepared 2026-09-11. The prompts below are saved examples, **not executed**.
Use a disposable project outside the Beads Station checkout. Start with one
provider and one request. Provider requests consume your provider allowance;
ordinary terminal checks and the automated fixture suites do not launch providers.

## Build and check recent changes

From the Beads Station repository, use the existing installed dependencies:

```sh
npm run build
npm test
npm run test:live
cargo check --manifest-path src-tauri/Cargo.toml --quiet
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --debug --bundles app
```

Focused lifecycle checks while editing:

```sh
npm test -- src/components/designer/nativeRuns.test.ts
cargo test --manifest-path src-tauri/Cargo.toml claude::tests -- --test-threads=1
```

`test:live` is Chromium with mock IPC, not a native/provider test. The bundle is
`src-tauri/target/debug/bundle/macos/Beads Station.app`. Reveal that directory in
Finder and open the bundle explicitly. Do not quit an unrelated development
session to make the test pass. Record which bundle/process you actually tested.
The current implementation reconnects a renderer to the same running backend;
quitting the application or restarting its backend does not preserve native runs.
An absent process must remain unknown; never interpret it as completed work.

## First: terminal and settings, no provider cost

1. Open only the disposable workspace. Confirm discovery did not open every
   project or launch an agent. In its shell enter `printf 'shell=%s\n' "$$"` and
   `printf 'marker: café 日本語 🧪\n'`. Record the PID and marker.
2. Split right, then split down. Run the same PID probe in each pane. Close one
   selected pane: only its shell should stop. Zoom and restore the surviving
   pane. Choose **Unsplit to tabs**: every remaining shell and marker should
   survive as a tab. Revisit each tab and compare its PID.
3. Switch workspaces, then Developer/Designer views, then back. Open Settings,
   search for terminal, change cursor shape/blink, font size, line height and
   scrollback. Change appearance while a terminal tab is hidden, then revisit it:
   the new appearance should apply and its PID should be unchanged.
4. Choose different themes in Developer and Designer. Revisit both and reload
   the renderer to test persistence. Reset one view's theme and verify the
   other still has its chosen theme. Distinguish this renderer reload from quit.
5. Open `nvim` in the disposable project. Type text in Insert mode, press Escape,
   move around, resize/split, and quit normally. Escape must remain Neovim's key.
   Paste a short multiline Unicode sample and check it visually.

Pass evidence: app/bundle identity, per-pane PIDs before/after, screenshots of
both themes, and any exact error. A saved layout alone is not process survival.

## Scenario A: tiny read-only provider smoke

Create a Designer request, select one installed provider, and explicitly Start:

> Inspect only this disposable workspace. Do not modify files, install packages,
> start servers, or contact external services. Explain the top-level files in
> at most five bullets, then stop. If it is empty, say that it is empty.

Expected: one attempt; visible provider output; final status reflects the real
child exit. Navigate away and return while it runs. If it finishes too quickly,
use Scenario B for navigation/reload. Repeat with the other provider only when
you deliberately want to verify it. Installed does not mean authenticated.
If the CLI requires login, complete its ordinary login yourself; never paste
credentials into a request or bug report.

## Scenario B: a small playable game

Use Sol Medium as the initial model when your chosen provider exposes that
choice. Beads Station's native Designer path currently lets the provider choose
model/effort; the Everyday/Heavy preference is not proof of a dispatched model.
Record actual provider-reported model/usage when available, otherwise unknown.

> Build a small browser memory-pairs game in this disposable project. Use plain
> HTML, CSS and JavaScript, no dependencies, downloads, external assets or network
> services. Use eight pairs of simple text symbols in a 4-by-4 grid. Show moves
> and matched pairs, include Restart and keyboard-accessible cards, prevent a
> third flip while two unmatched cards are visible, and announce a win. Keep all
> files within this project. Add a README with local opening instructions and
> a short manual test checklist. Do not deploy, commit, push, or change machine
> configuration. Explain the files changed and checks actually performed.

While it runs, switch workspace/view and return. Reload only the renderer if a
normal developer reload action is available, then choose **Check status**. Check
that the same run/attempt reconnects, output is ordered without duplicates, and
there is no second launch. Do not start a duplicate request just because output
is quiet. If reload is unavailable in the packaged build, record that limitation.

Open the generated game locally using its README. Check: 16 cards/eight pairs,
keyboard operation, one flip per card, unmatched pair delay, blocked third flip,
matched cards stay visible, move count, win announcement, and Restart resets all
state. Save screenshot + changed-file list + checks. A provider's success message
is not evidence that these interactions work.

Follow-up revision prompt, only after inspecting the first result:

> Keep the existing game. Add a visible high-contrast focus indicator and a
> reduced-motion mode that follows the browser preference. Fix only those two
> items. Retest keyboard play and Restart. Do not add dependencies or deploy.

Approval must identify the exact run and artifact revision. If the app has no
working artifact capture/revision approval yet, record the review manually and
leave the app's approval gate incomplete. Do not close the request merely because
its process exited. See FOUNDATION-VERIFICATION.md for the current implementation
boundary before using preview/approval controls.

## Scenario C: cancellation and recovery

During a fresh Scenario B attempt in another disposable project, press Cancel
once, then Check status. Expect the original attempt to become cancelled after
its child is reaped and output drains. It must not become completed/approved.
Other workspaces' runs and shell PIDs should survive. A request may finish before
Cancel arrives; in that case its actual exit outcome is expected.

If cancellation is unconfirmed, keep the identity, record the message and check
status again. Do not relaunch over unknown ownership. Inspect partial changes
before starting a new attempt: cancellation does not undo file edits. Do not use
provider calls solely to manufacture a long sleep; automated shell fixtures cover
kill-before-drain, early pipe closure, timeout and exact-child reaping for free.

Separately test a full app quit/reopen only after saving work. This is a backend
restart boundary, not a promised live-session reconnect. Never kill the user's
unrelated dev process or a provider by a broad process-name match.

## Evidence sheet

Copy for each scenario; do not include credentials or private terminal output.

| Field | Observation |
| --- | --- |
| Date, bundle/build, workspace | |
| Scenario and exact prompt | |
| Provider / observed model / effort | unknown unless reported |
| Usage window before / after / reset time | user-visible readings, or unknown |
| Ticket / run / attempt | |
| Shell or worker PID before / after | |
| Navigation / renderer reload / app restart | specify which |
| Expected and actual result | |
| Files / screenshot / artifact revision | |
| Checks actually performed | |
| Failed check and reproduction | |

Try A first, then B, then one revision. Avoid running both providers and multiple
models on the same game unless measuring a specific comparison. For future
model routing and usage checkpoints see AGENT-MODEL-ROLES.md.
