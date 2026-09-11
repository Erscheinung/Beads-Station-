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

## Usage-conscious defaults — 2026-09-11

For the next session, start with **Sol Medium for a bounded implementation**;
use Terra for an ordinary small feature/investigation and Luna for precise copy,
CSS, or documentation maintenance. Use Astra for process ownership races,
architecture, conflicting evidence, or the final review of a risky integration.
A simple memory game with explicit requirements does not need Astra by default.
Increase effort for a concrete unresolved problem rather than choosing maximum
reasoning for every task. These are repository routing recommendations, not a
claim that every task must use a worker or that savings are guaranteed.

Official guidance describes Astra as strongest for difficult end-to-end work,
Sol for complex work, Terra for everyday work and Luna for clear repeatable work;
it recommends the lowest reasoning effort that achieves the result.
[Model guidance](https://learn.chatgpt.com/docs/models).
The five-hour allowance depends on work performed and model, not five hours of
unlimited execution. Official estimates are not fixed message quotas; use the
account's usage dashboard for actual remaining allowance and reset time.
[Usage guidance](https://learn.chatgpt.com/docs/pricing).

Evidence from this repository: earlier sessions exhausted the usage window;
Astra performed substantial routine UI work while Sol's last lifecycle patch was
interrupted and needed ownership repair. This supports tighter briefs and review
boundaries, not a measured model-quality or cost comparison. We have no reliable
per-model quota ledger for those sessions and must not invent a percent saved.
On this resume Astra owns Rust cancellation; one Sol High worker owns only
frontend reconciliation and its race tests. High is justified by async identity
races. Do not extend that worker into unrelated architecture automatically.

Before each new slice, state the recommended model/effort and why. Prefer one
implementation owner; add a worker only for independent useful work. For a
routine task with no independent root work, use Sol directly in the next thread
rather than paying for an idle Astra supervisor. Pass a short brief containing
owned files, one outcome, acceptance checks, and forbidden side effects. Review
its diff and evidence; an agent's success claim is not acceptance.

Suggested user prompts for future sessions:

> Sol Medium: implement only the next bounded bead in AGENTS.md. Preserve current
> changes. Run its focused checks, report changed behavior and evidence, and save
> the next handoff. Escalate ownership/concurrency ambiguity before expanding.

> Astra: review this specific lifecycle diff and failing reproduction. Resolve
> the ownership contract, then give Sol a bounded implementation brief if useful.

> Luna: update the test-workflow wording to match these exact new UI labels.
> Change documentation only; do not rerun the full application suites.

At session start and after each accepted slice, record the visible quota reading
if the user provides one, plus model/effort, attempts, relevant checks and outcome.
If quota is unavailable, write unknown. Do not infer quota from elapsed time or
context size. As a voluntary planning policy, reserve the last roughly 20% of a
known window for verification and handoff, and stop expanding around 10%; these
are recommended thresholds, not automatic access to or enforcement of quota.
Finish or safely checkpoint a patch before starting another. Never leave an
untested cancellation change as though older passing tests covered it.
