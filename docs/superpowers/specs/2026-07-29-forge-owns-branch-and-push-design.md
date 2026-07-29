# Forge owns the branch and the push — Design

**Date:** 2026-07-29
**Status:** Approved
**Closes:** #56. Structurally removes #50, #62, #63, and the tail of #58.
**Base:** `main` @ `60f5ad8`

## Problem

Forge infers three facts about an agent's output, and every inference has been a
bug this session:

- **Did the agent push a branch?** Inferred from `task.prUrl` being null — false
  for an agent that pushed a branch but could not open the PR (#62).
- **Which branch?** Discovered by listing the repository and guessing from
  candidate names, then adopting a branch that was merely "ahead of base" — which
  once adopted a six-week-old stranger branch and attributed it to a task whose
  agent had pushed nothing (#50).
- **Is it done?** Inferred from `turn_ended`, which is a claim about a model turn,
  not about the work.

The agent, meanwhile, is asked to do two things it cannot reliably do: choose a
branch name Forge will recognise, and open a pull request from a sandbox whose
egress allowlist omits `api.github.com` (#63). Observed live: an agent wrote a
correct change, committed it, pushed it under its own name, could not open the
PR, and Forge escalated the task as `stalled_no_branch` with the commits orphaned
on the remote.

The root cause is that Forge does not **control** the branch or the push. It
guesses at them after the fact.

## Constraint

The Claude Managed Agents session API exposes no raw command execution — only
agent turns (`events`), resources, and lifecycle. Forge cannot reach into the
sandbox and run `git push` itself. Any command the sandbox runs, an agent turn
runs. This rules out a backend `pushBranch()` primitive as a cross-backend
mechanism, and shapes the design: Forge dictates the push **command**, the agent
executes it inside a turn.

## Decisions

### The agent commits and pushes to the Forge-named branch; Forge owns the PR

The dispatch prompt and the repo's `AGENTS.md` instruct the agent: make the
change, commit it, and push it to the branch **Forge names** —
`git push origin HEAD:forge/<taskId>` — then stop. Do **not** open a pull
request; Forge does that.

The critical thing Forge takes from the agent is the *naming*, not the push. A
name Forge assigned is a name Forge can find, which is the whole point of #56.
Having the agent push proactively (to that dictated name) matters for a reason
the first draft of this design missed: **work must reach the remote before a
guardrail can halt the agent.** If the agent only committed and left the push to
Forge, a `no_progress` halt that fires before the agent's turn ends would strand
the commits in a sandbox Forge can no longer drive — the exact loss #62 was filed
for. Pushing as the agent works means the branch already exists when a halt
lands, and Forge picks it up from any state.

Opening the PR stays with Forge because that is the step the agent genuinely
cannot do — the sandbox egress allowlist omits `api.github.com` (#63) — and Forge
holds a GitHub App token that can.

### Forge assigns a deterministic branch name

Each task's head branch is `forge/<taskId>`. It is derivable from the task id, so
there is no schema change and no stored value to keep in sync; it is globally
unique; and it is self-identifying, so the branch name alone tells you which task
produced it.

### Forge's dictated push turn is the salvage path, not the primary path

The agent pushes as it works (above). But an agent may commit and fail to push —
it botched the command, or it pushed to the wrong name despite instructions
(agents demonstrably do this). So when a task reaches `turn_ended` with no PR and
the Forge-named branch does not yet exist ahead of base, Forge sends one turn
containing the exact command:

```
git push origin HEAD:forge/<taskId>
```

`HEAD` is whatever the agent committed on, so this both (a) pushes work the agent
forgot to push and (b) creates `forge/<taskId>` from `HEAD` even if the agent
pushed under its own name — recovering from disobedience without any branch
discovery. The agent is a shell for a command Forge wrote.

This salvage push is the only unrecoverable gap's boundary: if the agent
committed, was halted, and the session is already dead, no turn can run and the
commits are genuinely lost in the terminated sandbox. That case escalates with an
honest reason (below); it is a real limit of a remote sandbox with no exec
surface, not a design defect.

The salvage turn is sent **once per `turn_ended` cycle**, gated by a ledger event
(`push.requested`), exactly as the continuation nudge budget (#51) and the CI
retry budget (#60) are gated — one send per cycle, never per tick. This reuses a
proven pattern rather than inventing a new counter.

### "Done" is a fact Forge checks, not a flag it infers

Completion is defined as: **`forge/<taskId>` exists on the remote and is ahead of
base.** Forge checks this against GitHub directly, independent of the task's
status. This is what makes stranded work structurally impossible — there is no
task flag to get wrong, because Forge inspects the branch it named.

### Forge opens the PR

Once the Forge-named branch is ahead of base, the reconciler opens the PR from
`forge/<taskId>` — the exact name, no discovery, no candidate list, no
"any branch ahead of base" heuristic — and routes the task to the CI gate. The
PR is opened with Forge's GitHub App token, which has the API access the sandbox
lacks.

### Branch discovery is removed

Forge names the branch; the agent pushes to that name, and the salvage push turn
creates it from `HEAD` if the agent didn't. So a branch Forge cannot identify
never needs to be found — there is nothing left for discovery to do. The
candidate-name list, the `listBranches` discovery, and the `branchIsTaskOwned`
provenance gate are **deleted**. There is exactly one question: does
`forge/<taskId>` exist ahead of base, or not.

`branchIsTaskOwned` / `newestCommitDate` (`branch-ownership.ts`) exist only to
serve that discovery. They and their tests are removed with it.

## State flow

The completion check is keyed on the Forge-named branch and runs wherever a task
might have produced one — both `turn_ended` (the normal path) and a task that a
guardrail halted to `needs_human` (the salvage path that replaces the #62 reclaim
sweep). One helper, two callers.

Replaces the current `turn_ended → tryOpenPr (candidates → discovery)`:

```
turn_ended, no PR:
  is forge/<taskId> ahead of base on the remote?
    YES → open PR from forge/<taskId> → awaiting_ci
    NO  → has push.requested been recorded for this turn_ended cycle?
            no  → send `git push origin HEAD:forge/<taskId>`,
                  record push.requested → task stays turn_ended (wait)
            yes → the agent produced nothing pushable:
                    within the push budget → still working → wait
                    budget spent           → escalate needs_human
                                              (escalationReason 'no_commits')

needs_human, no PR, escalated for a stall (stalled_no_branch | no_commits | ci_retry_stalled):
  is forge/<taskId> ahead of base on the remote?
    YES → the agent had in fact pushed work (e.g. before a halt);
          open PR from forge/<taskId>, clear the escalation → awaiting_ci
    NO  → the escalation stands
```

"For this cycle" means: since the task last entered `turn_ended`. A new
`turn_ended` transition (the agent took another turn after the push) resets the
budget, so a genuinely-working agent is not starved, while a silent agent is
bounded.

The `needs_human` arm is the same reclaim logic as the #62 sweep, but keyed on
the exact Forge-named branch instead of provenance-gated discovery. It is why
work pushed before a guardrail halt is never lost, and it is checked from the
terminal `needs_human` state, so no task flag can strand it.

The escalation reason for "agent committed nothing" is a new
`escalationReason` value, `no_commits` — distinct from `stalled_no_branch`
(which described the old inference and is retained for other callers) because the
new contract can state the fact precisely: the agent did not commit anything to
push.

## Components

- **`apps/web/src/server/tick/dispatcher.ts`** — no new `createSession` field
  (the name is derivable), but the goal template gains the "commit and push to
  `forge/<taskId>`; do not open a PR" contract, with the task id rendered in. The
  branch name is computed via `forgeBranchName(taskId)` wherever needed.
- **`AGENTS.md`** (repo root, fetched into every prompt) — replace the current
  guidance with "commit your work and push it to `forge/<taskId>` exactly; do not
  open a pull request — Forge does that." The task id is templated in per task
  (the goal is rendered with vars), so the agent sees a concrete branch name.
- **`apps/web/src/server/tick/reconciler.ts`** — replace the `turn_ended` PR
  sweep with the completion check (open on exact-name match; salvage push turn,
  gated; escalate `no_commits` on budget-spent). Rework the existing
  stranded-work reclaim sweep to key on the exact Forge-named branch instead of
  `tryOpenPr` discovery. Delete the candidate-name list, the `listBranches`
  discovery, and the `branchIsTaskOwned` import.
- **`apps/web/src/server/tick/branch-name.ts`** (new) — a pure
  `forgeBranchName(taskId)` so the name is computed in one place and testable.
- **`apps/web/src/server/tick/branch-ownership.ts`** and its test — deleted.
- **`packages/db/src/schema.ts`** — add `no_commits` to the `escalationReason`
  enum (code-only; the column is a plain text enum, no migration, as with
  `stalled_no_branch` and `ci_retry_stalled`).
- **`apps/web/src/lib/api/openapi.ts` / `docs/api/openapi.json`** — regenerated
  for the new enum value.

## Error handling

- **Push turn fails** (`sendTurn` throws — session gone): the branch will not
  appear; the next cycle re-evaluates and, with the session dead, the existing
  session-terminated handling abandons the task. No special case.
- **Agent pushes to the wrong name** (ignores the dictated name): Forge's salvage
  push turn runs `git push origin HEAD:forge/<taskId>` and creates the right
  branch from `HEAD`. The stray branch is ignored; Forge only ever opens the PR
  from `forge/<taskId>`.
- **Agent committed nothing**: `git push origin HEAD:forge/<taskId>` with
  `HEAD == base` creates a branch with zero commits ahead. Forge's "ahead of
  base" check correctly reads this as no work → the budget-spent path escalates
  `no_commits`. The empty branch is inert.
- **Agent committed, was halted, session already dead**: no turn can run to push,
  and the commits are lost in the terminated sandbox. Nothing can recover this;
  the guardrail halt escalates with a reason noting commits may exist only in the
  sandbox. This is the one irrecoverable case and it is inherent to a remote
  sandbox with no exec surface, not introduced by this design.
- **Race**: the PR-open and the escalation both compare-and-swap on the observed
  status, as every reconciler transition already does.

## Testing

- **`forgeBranchName`** — pure, deterministic, contains the task id.
- **Reconciler, branch exists ahead of base** → opens the PR from
  `forge/<taskId>`, task → `awaiting_ci`. Mutation: point the open at a different
  branch → the test fails.
- **Reconciler, branch absent, first cycle** → sends the push turn with the exact
  command, records `push.requested`, task stays `turn_ended`. Mutation: drop the
  command's `forge/<taskId>` target → the test fails.
- **Reconciler, branch absent, push already requested, budget spent** → escalates
  `needs_human` / `no_commits`, does not resend. Mutation: remove the budget gate
  → the resend-storm test fails.
- **Agent pushed its own branch, Forge-named branch absent** → Forge does **not**
  open a PR from the stray branch (discovery is gone); it sends the salvage push
  turn targeting `forge/<taskId>`.
- **`needs_human` (halted), Forge-named branch exists ahead of base** → Forge
  opens the PR from `forge/<taskId>` and clears the escalation → `awaiting_ci`.
  This is the pushed-before-halt reclaim. Mutation: skip the `needs_human` arm →
  this test fails (work stays stranded).
- **`needs_human` (halted), no Forge-named branch** → the escalation stands, no
  PR opened.
- Every behaviour mutation-tested per the project convention: revert, confirm a
  specific named test fails, restore, source printed.

## Out of scope

- **Environment shaping** (#57, #58 root, #63 root — registry/API access sized to
  the task). This design removes the agent's *need* for `api.github.com`, which
  makes #63 moot for the PR-open case, but does not address a task that genuinely
  needs network for a build. Separate work.
- **A backend `pushBranch` primitive.** Not available on CMA; not pursued. If a
  backend ever exposes raw exec, Forge could push without a turn, but the turn
  mechanism works on every current backend and is the portable choice.
- **Removing `stalled_no_branch`.** Retained for the guardrail-halt path, which
  still escalates a genuinely branch-less halt.
