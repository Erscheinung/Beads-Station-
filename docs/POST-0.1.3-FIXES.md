# Post-v0.1.3 fixes — 2026-09-23

User requested installation, implementation, limited focused tests, and a commit
at each completed checkpoint. Tracking: `Code-t3w`. No push or new release.

## Installation

Installed official GitHub v0.1.3 Apple Silicon DMG to
`/Applications/Beads Station.app`, replacing v0.1.0. Published SHA-256 verified:
`51e502862e0f2395ab40407bedefaf7ba42da9abac3708fe094490eff10e8b41`.
Bundle version reads `0.1.3`; the native macOS About dialog also displays
`Beads Station Version 0.1.3 (0.1.3)`. Native app opened and displayed restored workspaces
and honestly stopped saved terminal screens. No provider launched.
Previous app backup: `/tmp/beads-station-install-v0.1.3/backup/Beads Station.app`.
Installer/checksum: `/tmp/beads-station-install-v0.1.3/`.

`codesign --verify --deep --strict` fails on both the original DMG app and installed
copy: `code has no resources but signature indicates they must be present`.
The app nevertheless opens on this machine. Tracked separately as `Code-t3w.8`;
repair packaging in a future higher patch, without overwriting v0.1.3.

## Requested work

| Item | Bead | Acceptance | Status |
| --- | --- | --- | --- |
| About version | `Code-t3w.1` | Display actual application version | Implemented `9af832a` |
| Automatic updates | `Code-t3w.2` | Plan two-remote release endpoints, verified update and safe restart | Future only |
| Destructive confirmations | `Code-t3w.3` | Confirm pane close; reversible do-not-ask preference in Settings; consistent lifecycle actions | Implemented `6660d7f` |
| Durable local config | `Code-t3w.4` | Keybindings, settings, semantic recordings and recipes survive DMG replacement; safe migration | Implemented `b8b5d3a`; real upgrade gate pending |
| Finder Load | `Code-t3w.5` | Accepting the native chooser immediately opens the selected workspace | Implemented `20faa86` |
| Tile input focus | `Code-t3w.6` | Directional selection transfers real cursor/keyboard input while retaining PTY identity | Implemented `e38a507` |
| Scroll ownership | `Code-t3w.7` | Navigation retains scroll; streaming respects user scrolling above output; investigate repeated text | Partial `1c27bf7`; terminal diagnosis underway |

## Future updater constraints

The user reports two remotes; `git remote -v` currently exposes only
`origin` at `https://github.com/Erscheinung/Beads-Station.git`.
Resolve the second endpoint and source/channel selection before implementation.
Design version discovery, signed update manifests and artifact verification,
download/install recovery, explicit handling of active terminals/provider runs,
restart behavior, and durable local configuration preservation. A new DMG alone
is not yet an implemented update protocol. No automatic update/restart code is
part of this request's implementation scope.

## Checkpoints and evidence

The configured implementation worker owns these source changes and validation;
the primary did not independently review worker code. All six initial source
checkpoints are committed. Native v0.1.3 launch is installation evidence, not
verification of subsequent source fixes. No new release, push, or provider call.

| Commit | Result | Focused worker evidence |
| --- | --- | --- |
| `9af832a` | About Settings reads actual application version | SettingsPanel 7/7 |
| `6660d7f` | Shared confirmations for pane/workspace/app close | destructiveActions + AppCloseGuard 5/5 |
| `b8b5d3a` | Versioned native preference store and browser migration | durableUserConfig 2/2 |
| `20faa86` | Native folder acceptance opens project directly | WorkspacePicker 7/7 |
| `e38a507` | Directional selection enters insert mode and focuses retained input | termPanes 25/25 |
| `1c27bf7` | Sequence identities deduplicate overlapping live/replayed Claude/Codex chat frames | ClaudeChatViewport 4/4 |

Worker also reported TypeScript, production build, Rust 116/116, and
`git diff --check` passing. The broad Rust run exceeded the preferred focused
scope and was not repeated. Native confirmation UI, fresh Finder acceptance,
keyboard/IME behavior, and actual upgrade migration remain unverified.

### Configuration and confirmation behavior

macOS configuration file:
`~/Library/Application Support/ai.beads-station.desktop/user-preferences.json`.
Tauri plugin-store writes a schema-versioned, allowlisted config object. Startup
hydrates before stateful React imports; native values take precedence over
browser values, merged values are saved, then mirrored to localStorage.
Credentials, provider runtime data, and raw terminal/session content are excluded.
Semantic recipes and their bindings are included. Store failures currently fall
back silently to usable browser preferences, so durable storage on failure is
not guaranteed; actual DMG-to-DMG migration is a remaining native check.

The confirmation guard covers closing panes, workspace tabs, and application/
window closure through keyboard, menu, window button, or system requests.
The shared preference can be disabled in the confirmation prompt and restored
at **Settings → Sessions → Confirm destructive actions**.

### Scroll diagnosis still in progress

A confirmed app-owned chat duplication race occurs when a live frame arrives
while scrollback is loading and appears again in replay. Commit `1c27bf7` stamps
Claude/Codex frames with sequence identities and deduplicates those deliveries.
It does not change terminal scrolling. Existing terminal code attempts to retain
viewport anchors across attach/write/resize, but that alone does not disprove the
reported terminal jumps. The terminal portion of `Code-t3w.7` remains in progress
for controlled streaming/navigation reproduction; no provider fault is asserted.
