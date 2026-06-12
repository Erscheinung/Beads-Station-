# Beads Station — Phase 1 Build Report

**Status:** BLOCKED — `.dmg` could not be produced.
**Date:** 2026-06-12
**Branch:** main
**Phase:** 1 (Tauri shell + bd/pty/claude bridges)

---

## Build command

```bash
cd ~/Code/Beads-Station
export PATH="$HOME/.cargo/bin:$PATH"
npm run tauri build
```

(`cargo` is not on the default PATH on this machine — it lives at `~/.cargo/bin/cargo` and was prepended for the build.)

Full build log captured at `~/Code/Beads-Station/build.log`.

## Result

**Build failed after ~31s** during the `cargo build --release` phase. No artefacts were produced.

```
src-tauri/target/release/bundle/        (does not exist)
src-tauri/target/release/bundle/dmg/    (does not exist)
```

`.dmg` size: N/A — bundle was never created.
`.dmg` path: N/A.

## Root cause

Three `error[E0119]: conflicting implementations of trait` failures, all on the same trait pair:

```
impl From<time::format_description::parse::format_item::HourBase>
  for <HourBase as ModifierValue>::Type
```

(declared inside `time 0.3.48`) overlaps with three blanket `impl<T: …> From<T> for …` declarations in:

| Crate                | Location                                    | Failing blanket impl                                  |
|----------------------|---------------------------------------------|-------------------------------------------------------|
| `tauri-utils 2.9.2`  | `src/acl/value.rs:117`                      | `impl<T: Into<Number>> From<T> for Value`             |
| `tauri-utils 2.9.2`  | `src/assets.rs:44`                          | `impl<P: AsRef<Path>> From<P> for AssetKey`           |
| `cookie 0.18.1`      | `src/expiration.rs:129`                     | `impl<T: Into<Option<OffsetDateTime>>> From<T> for Expiration` |

The conflict is real-but-spurious — `time::HourBase` does not actually impl `Into<Number>`, `AsRef<Path>`, or `Into<Option<OffsetDateTime>>`, but the rustc 1.96 coherence checker now refuses to rule out a future upstream impl that would create the overlap, so it fails compilation today.

This is **entirely upstream**. None of the Phase 1 source files (`bd.rs`, `pty.rs`, `claude.rs`, `lib.rs`, `IssueList.tsx`, `App.tsx`, etc.) are involved in the failure. The TS build (`tsc && vite build`) succeeded cleanly.

The `phase1-shell` agent that ran before me hit the exact same block and flagged it as out-of-scope; I confirm that diagnosis.

### Why this can't be fixed in Phase 1 scope

- **rustc 1.96** (the only toolchain installed via rustup on this machine) is the coherence-strict version. No older toolchain is available locally and rustup has no other channels installed.
- **`time = "0.3.48"`** is the latest version published on the configured registry. `cargo update -p time` is a no-op. There is no released fix.
- **`tauri-utils 2.9.2`** and **`cookie 0.18.1`** are the latest published versions; both are pulled in transitively by `tauri = "2"`. `cargo update -p tauri-utils -p cookie` is a no-op.
- A `[patch.crates-io]` of `time` was attempted (vendored copy with the offending macro arm removed); it cascades into rewriting the `target_value!`/`target_ty!` macros and downstream parser call sites — substantially larger than a Phase 1 hot-patch should be.
- Forking `tauri-utils` to drop the blanket `From<T>` impls would require parallel changes across the tauri 2 dependency graph.

The right resolution is one of:
1. Wait for a `time 0.3.49+` upstream release that removes the offending blanket-shadowed impl.
2. Wait for `tauri-utils` and `cookie` to publish versions that narrow the blanket `From<T>` bound.
3. Pin the local toolchain to a pre-1.94 rustc via `rust-toolchain.toml` once an older toolchain is installable on this machine.

A separate beads issue should be filed to track this; suggested ID family `Code-build-toolchain`.

## Architecture(s) the bundle would have supported

Target: `aarch64-apple-darwin` (Apple Silicon only, single-arch). Universal (`universal-apple-darwin`) was **not** configured in `tauri.conf.json` for Phase 1.

## Code-signing status

**NOT SIGNED.** No Developer ID certificate was configured for Phase 1, and signing is intentionally deferred. When the underlying upstream toolchain block is cleared and a `.dmg` is produced, first launch will require **Right-click → Open** to bypass Gatekeeper. Code-signing + notarization is deferred to **Phase 10** per the master plan.

## Smoke-test results

**Not performed.** No `Beads Station.app` binary was produced, so there is nothing to launch. Console.app shows no relevant crash entries (because the app never started).

When the build is unblocked, the smoke-test the parent script described should run:

```bash
"~/Code/Beads-Station/src-tauri/target/release/bundle/macos/Beads Station.app/Contents/MacOS/beads-station" &
sleep 10
ps -p $!     # confirm alive
kill $!
```

## Build duration

~31 seconds — failed during dependency compilation (after ~190 crates compiled, when `tauri-utils` and `cookie` were reached). A full successful build is expected to take 4–8 minutes on first run.

## Phase 1 vs full plan — known limitations

Per the master plan at `~/.claude/plans/we-have-a-git-synthetic-dusk.md`:

- Phase 1 ships only the three-pane shell (issue list, terminal, claude chat) with subprocess bridges to `bd`, `portable-pty`, and `claude` (stream-json).
- **Not in Phase 1:** dolt sync UI, dependency graph view, batch operations, settings panel, code-signing/notarization, auto-update, Windows/Linux bundles, telemetry.
- Phase 10 covers signing + notarization and gated rollout.

## Warnings observed (non-fatal, would have been issued on success too)

- `tauri.conf.json` `identifier` is `ai.beads-station.app`, ending in `.app` — Tauri warns this clashes with the macOS bundle extension. Recommend renaming to `ai.beadsstation` or `ai.beads-station.desktop` before Phase 10.
- Vite warning: `@tauri-apps/api/core` is both statically (in `event.js`, `ClaudeChat.tsx`, `Terminal.tsx`) and dynamically (from `src/types/issue.ts`) imported, so the dynamic chunk-split is a no-op. Cosmetic; bundle still ships correctly.

## Next steps for parent agent

The parent should treat Phase 1 as **code-complete but build-blocked**. The phase should not be marked done in beads. File a follow-up beads issue for the toolchain block and let Phase 2 proceed independently if its work doesn't depend on a runnable binary.
