# Beads Station

A local macOS workspace for terminals, Neovim/LazyVim, tickets, and coding agents, built with Tauri 2, Rust, React, and xterm. The conductor and designer workspace are evolving toward a shared request → implementation → review workflow.

> **Early preview — v0.1.0.** The Developer workspace is usable for local evaluation. The Designer workspace is a visual prototype only and is not yet a working end-to-end request, run, preview, or approval flow.

## Preview

### Developer workspace — Fahrenheit theme

![Developer workspace using the Fahrenheit theme](docs/images/releases/v0.1.0/developer-fahrenheit.png)

### Designer workspace — prototype

![Designer workspace prototype](docs/images/releases/v0.1.0/designer-prototype.png)

The Designer screenshot demonstrates the intended information architecture and visual direction. Its controls and workflow should not be treated as production-ready behavior.

## Install the v0.1.0 preview

The first release is an ad-hoc-signed, unnotarized Apple Silicon macOS DMG; it is not signed with an Apple Developer ID. Download `Beads Station_0.1.0_aarch64.dmg` from the Releases page, open it, and drag **Beads Station** to **Applications**. If Gatekeeper blocks the first launch, right-click the app and choose **Open**, or allow it once in **System Settings → Privacy & Security**.

Install `bd` to use ticket surfaces. `codex`, `claude`, and `nvim` are optional and are launched only when you explicitly use them. Authentication stays in each CLI's own login flow. See the [v0.1.0 release notes](docs/releases/v0.1.0.md) for the verified feature list, known limitations, test checklist, and future plans.

## Current foundation

- **Explicit workspaces:** search discovered projects or enter any folder path. Discovery does not open tabs or start agents. Only explicitly opened workspaces are restored.
- **Portable discovery:** configurable roots in the workspace picker. The initial suggestion prefers `~/Desktop/Code` when present, otherwise an existing `~/Code`. Missing roots appear as recoverable warnings.
- **Independent identity:** deterministic IDs based on canonical folder paths keep same-name projects separate. Opening a project remembers its folder and allocates its session; discovery is read-only.
- **Terminal navigation:** split panes, tabs, zoom, and saved layouts. Shells and their xterm screens survive project/tab switches, collapse/expand, and skin changes within the running app. Closing a workspace stops its terminals.
- **Agents on intent:** the optional Claude chat starts when requested. Installed `codex`, `claude`, and `nvim` can also run directly in the terminal. Persistent agents have a separate capacity budget from short bd/git operations.
- **Tickets and appearance:** bd issue board/tree, command palette, palette-driven surfaces and Ghostty-style theme import.
- **Designer workspace prototype:** available from the landing screen or command palette, and through `?ui=designer` on a fresh profile. It can visualize request-oriented concepts, but its complete request/run/preview/review workflow does not work yet.

This branch is foundation work, not a completed CMUX replacement. Closing the native window still stops local processes; saved layout restoration is not live process persistence. Durable runtime attachment, a structured Codex adapter, designer previews, and external GitHub/Jira pulses remain in the [Astra plan](docs/ASTRA-DAILY-DRIVER-PLAN.md).

## Development

Prerequisites: macOS, Node/npm, Rust/toolchain from `rust-toolchain.toml`, and Xcode command-line tools. Install `bd`, `claude`, `codex`, or `nvim` for the integrations you use. Log into the agent CLIs using their own terminal login flows; a gateway key is not required.

```sh
npm install
npm run tauri dev
```

Initialize the repository-local Beads database after a fresh clone (or after
moving the checkout to another machine):

```sh
npm run beads:setup
```

This runs `bd bootstrap --yes`, which imports the tracked
`.beads/issues.jsonl` export into an ignored embedded Dolt database under this
clone's `.beads/` directory. The database is local to the checkout, so clone
paths and machines do not need to match. Re-running the command is safe and
does not edit the tracked JSONL export or commit runtime database files. It
requires a current `bd` installation with the `bootstrap` command.

The native app uses port 1420. Open a project from the picker, then use the terminal or start an agent explicitly. The `+` beside workspace tabs and **Open workspace** in the command palette return to the picker. **Discovery roots** accepts one root per line. Folder paths can start with `~/` and may contain spaces; no shell interpolation is used to open them.

To install the JavaScript dependencies, pinned Rust toolchain, and macOS
development prerequisites before starting the app, run ./setup.sh.

The frontend `predev`/`prebuild` hooks run `scripts/audit-emoji.mjs`, which fails the build if any emoji glyphs land in JSX text (Codicons via the `codicon` font are fine; literal emoji are not).

Application workspace settings and session IDs are stored with Tauri's plugin store. The frontend stores the explicit open-workspace list, active workspace, layout, and appearance locally. The legacy active-project setting is migrated only when unambiguous; old discovery results are not treated as an open-workspace list.

## Authentication and optional notes

Native CLI authentication is the default. At startup, native mode removes inherited Anthropic gateway API-key/base-URL overrides so they do not override the CLI's local account. The app does not read or copy the CLI's credentials. Gateway spending lookups are disabled in native mode; unavailable usage is not represented as a fabricated quota.

To opt into a gateway on a machine that needs it:

```sh
BS_AUTH_PROFILE=gateway BEADS_STATION_ENV=/absolute/path/to/private.env npm run tauri dev
```

The explicit file can contain the gateway's Anthropic environment variables. Do not commit credentials. No `.env` file is searched automatically beside the executable or on another user's filesystem. Gateway mode can also use explicitly inherited environment variables.

Optional daily notes and sensors share `~/Documents/Beads Station`. Override the root with `BEADS_STATION_VAULT=/path/to/vault` (or a quoted `~/...` path). Daily entries go to `Daily/`; sensors inspect `Daily/` and `Implementation Prompts/`. This integration is independent of project discovery.

## Resource limits

- `BS_MAX_SPAWNS`: short bd/git operations, default 3, maximum 16.
- `BS_MAX_AGENTS`: persistent Claude/conductor processes, default 4, maximum 32.
- `BS_MAX_TERMINALS`: local PTYs, default 16, maximum 64.

At agent/terminal capacity, a new request reports a clear error instead of waiting indefinitely. UI reads retain their own capacity. These are local resource limits, not token budgets.

## Verification

```sh
npm run build
npm test
npx playwright install chromium  # once per Playwright browser version
npm run test:live
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --quiet
```

The build includes the emoji audit. Unit tests use two workers and jsdom storage, including on Node 25. Browser tests run on **port 1422** with mock IPC so they can coexist with native development on 1420. They verify browser focus and UI behavior, not WKWebView, native authentication, actual PTYs, or process persistence. Use the native app for those checks.

For an app bundle:

```sh
npm run tauri build
```

Old DMG artifacts may predate the native file-limit repair and can produce repeated `Too many open files (os error 24)` notifications. Quit old Beads Station instances and replace them with the current DMG before evaluating the app. Signing, notarization, auto-update, and broader distribution polish remain future work.

## Agent workflow

Read [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), and the [implementation plan](docs/ASTRA-DAILY-DRIVER-PLAN.md). `BEADS-CONTEXT.md` records historical work and should not be treated as a current machine setup guide. Track implementation with bd from this repository, using verified writes; do not edit the database or passive JSONL export by hand.
