# Post-v0.1.3 fixes — 2026-09-23

User requested installation, implementation, limited focused tests, and a commit
at each completed checkpoint. Tracking: `Code-t3w`. No push or new release.

## Installation

Installed official GitHub v0.1.3 Apple Silicon DMG to
`/Applications/Beads Station.app`, replacing v0.1.0. Published SHA-256 verified:
`51e502862e0f2395ab40407bedefaf7ba42da9abac3708fe094490eff10e8b41`.
Bundle version reads `0.1.3`; native app opened and displayed restored workspaces
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
| About version | `Code-t3w.1` | Display actual application version | In progress |
| Automatic updates | `Code-t3w.2` | Plan two-remote release endpoints, verified update and safe restart | Future only |
| Destructive confirmations | `Code-t3w.3` | Confirm pane close; reversible do-not-ask preference in Settings; consistent lifecycle actions | Planned |
| Durable local config | `Code-t3w.4` | Keybindings, settings, semantic recordings and recipes survive DMG replacement; safe migration | Planned |
| Finder Load | `Code-t3w.5` | Accepting the native chooser immediately opens the selected workspace | Planned |
| Tile input focus | `Code-t3w.6` | Directional selection transfers real cursor/keyboard input while retaining PTY identity | Planned |
| Scroll ownership | `Code-t3w.7` | Navigation retains scroll; streaming respects user scrolling above output; investigate repeated text | Planned |

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

Implementation evidence will be recorded here after each bounded slice. Native
v0.1.3 launch is installation evidence, not verification of subsequent source fixes.
