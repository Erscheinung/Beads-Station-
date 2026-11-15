# Qwen integration contract (Beads Station side)

Goal: a local Qwen picks up Beads Station tasks, and its work shows up in the
Designer's Agents and Timeline views next to Claude and Codex, without Beads
Station launching or driving it.

Status: provider slot only. The `qwen` provider id, its icon (`ProviderMark`)
and the History/Agents/Timeline plumbing exist; **no Qwen source is read yet**.
Reason: the Qwen workbench (`~/Desktop/Code/qwen-workbench`, see its
`docs/beads-station-integration.md`) writes no per-session transcript files that
Beads Station can parse today, and there is no `qwen` binary on this machine, so
nothing could be verified. Do not guess a path.

## What the workbench already exposes (from its docs, unverified here)

| Need | Workbench surface |
| --- | --- |
| Shared tasks and contract | the repo's `bd` database (`check:`, `scope:`, `review:` lines in acceptance criteria) |
| Live status | `state/autopilot/status.json` (current bead, step, last actions, loop warnings, `recent[]`) plus `log.jsonl`; location from `qwen task paths` |
| Hand a bead over | `qwen task delegate <id> [repo]`, `qwen task resume <id>` |
| Steer | `qwen task guide <id> "<text>"`, `qwen task handoff <id>` (pickup note) |
| Sessions | persisted as JSONL by its own UI process (format not documented for outside readers) |

## Contract proposed for a read-only Qwen source

1. **Discovery**: the workbench writes (or Beads Station asks it for) one small
   JSON per attempt, e.g. `state/autopilot/attempts/<bead>-<n>.json`:
   `{ id, bead, repo, startedAt, updatedAt, state: running|waiting|finished|blocked, title, steps, subagents?: [...] }`.
   Beads Station reads files only; the `repo` field is matched to the open workspace.
2. **Mapping** to `TranscriptSummary`: `provider: "qwen"`, `id`, `title`,
   `firstPrompt` (must contain the bead id so `mentionsBead` links it),
   `createdMs` from `startedAt`, `modifiedMs` from `updatedAt`, `parentId` for
   Luna/worker calls, `finished` from `state`.
3. **Transcript**: a JSONL with one record per turn (role, time, text, tool name,
   tool summary, result, files). `transcripts.rs` gets a `parse_qwen` beside
   `parse_codex`; the page still sends only (provider, id), never a path.
4. **Where the directory comes from**: an explicit setting or `QWEN_WORKBENCH_DIR`,
   never a scan of the disk. Absent means no Qwen rows, not an error.
5. **Picking up tasks**: Beads Station never runs Qwen on mount, discovery or
   restore. A ticket's explicit "Delegate to Qwen" action (a click) types or
   runs `qwen task delegate <id> <repo>` and shows the result. Beads labelled
   `model:qwen` are routed to it by the conductor only when the user enabled
   that tier. Approval still binds to one run and artifact revision; Qwen's own
   `check:` result is evidence, not approval.
6. **Honesty**: unknown usage stays unknown; a Qwen run without an end record
   shows as idle then finished by quiet time, like Claude/Codex sessions.

## Open questions for the workbench owner

- Will the autopilot write the attempt files above (or document its session JSONL)?
- Is `status.json` stable enough to read directly every 5 s as an interim source?
- How are Luna/worker calls recorded, so they nest as subagents?

## Where it plugs in

`src-tauri/src/transcripts.rs` (`list`, `read`, add `list_qwen`/`parse_qwen`),
`src/components/designer/transcripts.ts` (`TranscriptProvider` already has
`qwen`), `DesignerShell.tsx` (`onResume` ignores `qwen` until a resume command
exists), `src/components/ProviderMark.tsx`.
