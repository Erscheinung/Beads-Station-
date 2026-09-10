# Agent model roles

This is the operating policy for assigning work in Beads Station. Model names
describe responsibilities, not hard-coded provider IDs. The runtime must show
the model and effort that actually ran, and fall back or pause honestly when a
configured model is unavailable.

## Astra: product lead and master orchestrator

Astra owns product direction, interaction design, architecture, task
decomposition, risk assessment, final review, and coordination across agents.
Use Astra for ambiguous work, novel design, cross-cutting changes, difficult
tradeoffs, and recovery when another worker produces weak or conflicting
evidence. Astra should keep the product coherent, prepare bounded assignments,
choose the cheapest capable worker, and verify results. It should avoid spending
its context on routine mechanical implementation that a worker can complete
from a precise brief.

## Sol: primary implementation worker

Sol owns substantial, well-scoped implementation: multi-file features,
refactors, Rust/TypeScript integration, test changes, and executing a design
that Astra has made concrete. Give Sol acceptance criteria, relevant files,
constraints, and a verification command rather than the repository's entire
history. Treat 200,000 tokens as a hard per-run context ceiling. Astra should
split work before that ceiling becomes a risk and require a concise handoff at
the end of each slice. Sol may surface design conflicts, but Astra decides
product or architectural changes.

## Terra: medium work and bounded investigation

Terra handles medium-sized work with clear boundaries: one subsystem, a focused
feature, test coverage for behavior, code review, migration preparation, or a
diagnosis that needs more reasoning than a small bug fix. Terra is also the
default second opinion for Sol's implementation when the change is meaningful
but does not require Astra's full product judgment.

## Luna: fast fixes and narrow maintenance

Luna handles reproducible, low-risk bugs, small UI defects, warning cleanup,
localized tests, documentation corrections, and other narrow maintenance. A
small diff is not automatically a Luna task: authentication, persistence,
process ownership, cancellation, concurrency, and data-loss risks escalate to
Terra or Astra even when only a few lines change.

## Routing and escalation

Route deterministically from task scope, uncertainty, affected systems, and
risk. Prefer Luna for narrow low-risk work, Terra for a bounded subsystem, Sol
for substantial implementation, and Astra for design, orchestration, or high
uncertainty. Do not route only by estimated line count.

Astra gives every worker one owned outcome and an explicit evidence contract.
Independent tasks may run concurrently; overlapping edits, releases, and merges
must have one owner. Escalate after a behavioral test failure, repeated weak
attempts, unexpected cross-system coupling, or evidence that the assigned model
lacks context. Environment failures should be diagnosed rather than treated as
model failure. Keep retries bounded and preserve the strongest intermediate
artifact before escalating.

Completion requires source or artifact review plus the relevant checks. A
worker's claim, a zero process exit by itself, or a cancelled run is not proof
of completion. Astra records the effective model, effort, checks, unresolved
native gates, and next bounded task in the milestone handoff.
