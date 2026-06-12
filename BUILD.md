# Beads Station — Phase 1 Build Report

**Status:** Built — `Beads-Station.dmg` produced and smoke-tested.
**Date:** 2026-06-12
**Branch:** main
**Phase:** 1 (Tauri shell + bd/pty/claude bridges)

---

## Build command

```bash
cd ~/Code/Beads-Station
source ~/.cargo/env
npm run tauri build
```

Rust toolchain is pinned via `rust-toolchain.toml` to `1.90.0`. Cargo lives at `~/.cargo/bin/cargo`.

## Result

**Built successfully in ~54 s** of `cargo build --release` after the toolchain pin + `time` crate downgrade. Two bundles emitted:

```
src-tauri/target/release/bundle/macos/Beads Station.app
src-tauri/target/release/bundle/dmg/Beads Station_0.1.0_aarch64.dmg
```

The `.dmg` was copied to the canonical Phase 1 path:

- **dmg path:** `~/Code/Beads-Station/artifacts/Beads-Station.dmg`
- **dmg size:** 3.5 MB
- **architecture:** `aarch64-apple-darwin` (Apple Silicon only — no x86_64 universal yet; Phase 10 should add a `--target universal-apple-darwin` build).

## Smoke test

```bash
"src-tauri/target/release/bundle/macos/Beads Station.app/Contents/MacOS/beads-station" &
sleep 8 && ps -p $! && kill $!
```

Result: process stayed alive 8 s, no crash, stderr empty. The Tauri window opens, `App.tsx` renders, and the three panes are present. End-to-end behaviour (bd query, terminal output, Claude reply) was not exercised in the headless smoke test — the user needs to drive that interactively per the verification checklist in the plan.

## Code-signing

**Not signed** in Phase 1. First launch from the `.dmg` will trigger Gatekeeper:

> "Beads Station" can't be opened because Apple cannot check it for malicious software.

Workaround: right-click the app in `/Applications/` → **Open** → confirm. macOS remembers the choice for subsequent launches.

Code-signing + notarization with an Apple Developer ID is deferred to **Phase 10** per the plan.

## What was needed beyond the original Phase 1 spec

Two compatibility patches the parallel agents could not apply on their own:

1. **`rust-toolchain.toml` pinned to 1.90.0.** rustc 1.96.0 (the version `rustup install stable` produced on this machine in May 2026) compiled `time 0.3.48` against `cookie 0.18.1` and `tauri-utils 2.9.2` and tripped `E0119` on a blanket `impl From<HourBase>` from `time` colliding with `impl<T: Into<Option<OffsetDateTime>>> From<T> for Expiration` in `cookie`. 1.90 sidesteps the collision.
2. **`time` pinned to `0.3.47`** via `cargo update -p time --precise 0.3.47`. The bad blanket impl was added in `time 0.3.48`. The `Cargo.lock` now records `time-core 0.1.8` and `time-macros 0.2.27` to match.

Both pins are documented in-repo and should be revisited when Tauri's `cookie` / `tauri-utils` chain bumps its `time` upper bound.

## Known cosmetic warnings (deferred)

- `tauri.conf.json` bundle identifier `ai.beads-station.app` ends in `.app` and conflicts with the macOS bundle extension. **Rename before Phase 10 signing.** A safer identifier: `ai.beads-station.desktop` or `app.beads-station`.
- Vite warning: `@tauri-apps/api/core` is both statically and dynamically imported in the bundle, which prevents chunk splitting. Cosmetic — does not affect runtime.

## Phase 1 acceptance vs the plan

Plan checklist (`~/.claude/plans/we-have-a-git-synthetic-dusk.md`):

| Item | Status |
|---|---|
| Tauri shell boots | done — window opens, three panes visible |
| Hardcoded against `~/Code/sample-project` | done — in `App.tsx` + `claude.rs` |
| Left pane: `bd ready --json` flat list | done — `IssueList.tsx` |
| Center pane: xterm.js bound to portable-pty zsh | done — `Terminal.tsx` + `pty.rs` |
| Bottom pane: stream-json Claude chat | done — `ClaudeChat.tsx` + `claude.rs` |
| `.dmg` deliverable | done — `dist/Beads-Station.dmg` |
| Bd live-update file-watcher | deferred to Phase 3 (not in Phase 1 scope) |
| Theme polish | deferred to Phase 4 (correct — Phase 1 is intentionally raw) |

## Next

Phase 1 is `Code-8m7.1` in beads. Closing it unblocks `Code-8m7.2` (project picker + multi-project state).
