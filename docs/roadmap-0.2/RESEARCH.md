# Research options and decisions

Checked 2026-09-16 through official documentation, GitHub repository APIs/READMEs,
and the two local checkouts. This is a source-based comparison, not a benchmark or
compatibility certification. No referenced installer, hook, provider or harness ran.
Pin a release/commit and validate installed protocol versions before implementation.

## Harness selection

| Candidate and primary source | Observed scope | Proposed use and uncertainty |
| --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex), [App Server documentation](https://learn.chatgpt.com/docs/app-server) | Structured thread/turn integration, events, configuration and session operations. | First Codex adapter. Separate availability, stored history, idle resume and new generation. Existing `src-tauri/src/codex.rs` is a starting boundary, not verified Designer parity. |
| [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python), [permissions](https://platform.claude.com/docs/en/agent-sdk/permissions) | Official Claude harness SDK; README documents CLI bundling and tool permissions. | Compare supported CLI streaming versus SDK for the existing Rust subprocess integration. Adding a Python runtime to the DMG is a packaging cost, not a prerequisite. Verify actual idle-resume and cancel behavior. |
| Local Codex Adaptive Orchestrator | Instruction/configuration profile for adaptive Sol/Luna ownership, bounded children and no mandatory reviewer. | Preferred initial Codex orchestration preset. Import as reviewed instructions/role mapping; it is not a standalone durable process runtime. |
| [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) (old `badlogic/pi-mono` redirects here) | Minimal coding harness with extensions, skills, templates, interactive/JSON/RPC/SDK modes; README says subagents/plan mode are not built in. | Borrow composable configuration and small integration surface. Evaluate RPC as an optional adapter. Multiple model providers are not proof of native Claude Code/Codex CLI lifecycle parity or interchangeable login. |
| [9thLevelSoftware/Clodex](https://github.com/9thLevelSoftware/Clodex) | Claude/Codex handoff layer with durable coordination, MCP tools and a prescribed dual-audit workflow. | Borrow explicit handoff records and bounded agreement. Its fixed model assignments and dual-review policy conflict with this repo's adaptive/no-review contract; do not import those defaults. License was not identified by GitHub metadata; establish rights before copying. |
| [bman654/clodex](https://github.com/bman654/clodex) | Different project: provider bridging, OAuth/API options and optional Claude binary patching. | Research-only alternative. Runtime patching adds update/support burden; not a recommended DMG default. Its account/terms compatibility statements are maintainer claims, not verified here. Do not patch a user's CLI. |
| [lukaskucinski/clodex](https://github.com/lukaskucinski/clodex) | Different Claude plugin describing a Claude-build/Codex-review loop with PR shipping. | Discovery lead only; unnecessary default review/spending and external-write behavior for this product. Do not conflate with either project above. |

Recommended shortlist: native Codex and Claude first; local adaptive Codex profile
second; an explicit bounded mixed workflow third; Pi RPC as an optional experimental
adapter after conformance. Keep the generic import route open. No measured evidence
supports declaring one external harness faster or cheaper. Evaluate equal tasks with
reported tokens, wall time, process memory, retries and accepted outcomes; unknown
usage remains unknown. A paired workflow may cost more while solving a harder task.

### Codex resume boundary

The [App Server documentation](https://learn.chatgpt.com/docs/app-server) separates
`thread/read` (stored history), `thread/resume` (load an existing thread), and
`turn/start` (begin generation). Use that distinction to test no-new-turn restoration.
Resuming may initialize configured services; it is not a guarantee of zero network
activity or zero cost from previously active work. Capture provider-observed identity
and check current protocol support rather than extrapolating from terminal text.
The automated fixture must reject an unexpected `turn/start` on app reopen.

### Local adaptive harness inspection

Path: `~/codex-astra-luna-orchestrator`.
Inspected README and file inventory at `578745bd63163c67b4389eef545b3ffc11714a8b`.
Reference files: `profiles/plus/codex/config.toml`, `agents/*.toml`, `hooks.json`,
`hooks/continue_on_stream_disconnect.py`, `guides/token-usage.md` and the README.
Do not execute setup scripts to inspect/import a profile.

Its documented installer writes project config/instructions; import must first show
those targets and preserve existing settings. Its README explicitly distinguishes a
local stream-error hook from the new `continue` model turn that the hook requests.
Disable such continuation in the no-cost restore path. Existing global Codex config
continues to own this user's role assignments. Store app profiles separately and make
any export into external CLI configuration a distinct, reviewable operation.

## Runtime continuity and interaction references

| Reference | Source finding | Beads Station decision |
| --- | --- | --- |
| [Herdr](https://github.com/herdrdev/herdr), [session state](https://herdr.dev/docs/session-state/), [socket API](https://herdr.dev/docs/socket-api/) | README describes a background terminal server that survives client detach, and explicitly distinguishes reconstruction after server/machine restart. Apache-2.0 according to repository metadata. | First bounded durable-owner evaluation; no promise that the existing bridge supports current raw terminal transport. Prove streaming/replay/input/resize/cancel/reattach before adoption. Do not embed a second scheduler or migrate ordinary terminals just because agent status works. |
| Local [cmux](https://github.com/manaflow-ai/cmux) | README distinguishes saved app state/provider IDs from arbitrary process survival and points to local tmux for live detach. Settings separate terminal configuration from app shortcuts. | Borrow focus history, attention navigation, hidden-surface handling, shortcut recorder and truthful restore UX. Swift/Ghostty implementations are not React/xterm patches. |
| [Omarchy tiling bindings](https://github.com/omacom/omarchy/blob/2fbac0c8e88eca704af1650ce721a494bd11a3d0/default/hypr/bindings/tiling.lua) | Separate directional focus, swaps, workspace selection, group cycling, fullscreen and resizing actions. | Borrow command taxonomy and spatial behavior. Do not transplant Linux Super shortcuts into macOS or install Hyprland. Preserve existing Beads shortcuts and offer an optional ergonomic preset. |

cmux path: `~/Desktop/Code/cmux`, inspected at
`8c53ab55d2e33f785f1bdafda53d99a561d8c098`. README, LICENSE and part of
`cmuxTests/TerminalWindowPortalLifecycleHiddenRefreshTests.swift` were inspected.
That test separates clipping boundaries from avoiding synchronous refresh on hidden
surfaces. This is a useful hypothesis for measurement, not evidence of the cause in
xterm. Other useful inventory leads (not reviewed implementations):
`SessionPersistenceResumeBindingTests.swift`, `TabManagerSessionSnapshotTests.swift`,
`FocusHistoryBracketShortcutRoutingTests.swift`, and
`SidebarWorkspaceSwitchLayoutFaultTests.swift`.

The local cmux LICENSE states GPL-3.0-or-later with additional third-party notices.
Borrow interaction ideas and independently implement; inspect licensing obligations
before copying any code/assets. No source/assets were copied in this planning pass.
The older Hyprland Dispatchers wiki URL returned 404; the fetched Omarchy source is
the concrete reference for this plan. Confirm current Hyprland docs if later needed.

### Herdr go/no-go experiment

In a disposable workspace, pin a version and establish Finder executable discovery,
version handshake, authenticated/local socket boundary, start/list/attach, raw bytes
with UTF-8 split chunks, screen snapshot/replay ordering, input and resize, alternate
screen state, and bounded buffering. Record the exact session and PID before GUI
close, after reattach, and after daemon restart. Test concurrent clients, stale handles,
PID reuse, lost acknowledgments, exact-child cancel, offline reconnect and cleanup.
Text-only `agent.read` cannot satisfy terminal reattachment. If the supported API
cannot pass, document why and choose one minimal app-owned daemon. Keep this evaluation
to one bounded assignment; do not maintain two new production owners for the release.

## Connections and installed-app configuration

The [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
defines HTTP authorization and distinguishes stdio credentials supplied through the
process environment. The app's design should therefore support separate auth paths,
explicit per-connection scopes and secret references, with browser login where the
server supports it. A universal “connect” form does not guarantee every service's
authentication or request mapping. Validate against exposed schemas and real accounts
only when the user deliberately tests them.

[Tauri Window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)
is the API reference to revisit for close interception; lifecycle behavior needs a
native packaged test, not a browser-only listener assertion. App config lives outside
the signed bundle and should be reachable through Settings without shell commands.

Public GitHub/Figma/Jira examples are mapping targets, not verified integrations in
this research. `work-auth-mcp` and `work-tools` are user-named internal follow-up work;
no schema, endpoint, credentials, or authentication claims are made. See the dedicated
Sol prompt before using them in the environment where they are exposed.

## Pins and evidence limits

GitHub HEADs observed during research (READMEs were fetched from default branches
near these observations; re-fetch at the pin before adopting code):

| Repository | Observed commit |
| --- | --- |
| openai/codex | `4701aa4b4239c70063ab6f2fcb835324f9c109f4` |
| herdrdev/herdr | `aff99878d3467e809e18f07fb338c78dea50e558` |
| earendil-works/pi | `9e05370b298d0a6b8d9bc2c02e4bfae189ef1616` |
| 9thLevelSoftware/Clodex | `895edd20c1fa0f27a615ed8aace6ed01dbcd2adf` |
| omacom/omarchy | `2fbac0c8e88eca704af1650ce721a494bd11a3d0` |

Pi metadata reported MIT; official Claude Python SDK metadata reported MIT. Recheck
all transitive components and packaging licenses before redistribution. No harness
conformance, live authentication, performance superiority or native bug reproduction
is claimed from documentation. Proposed architecture in MASTER-PLAN.md is our design,
not a claim that any of these projects already provides the complete product.
