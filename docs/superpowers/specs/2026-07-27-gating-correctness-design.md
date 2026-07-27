# Gating Correctness — Design

**Date:** 2026-07-27
**Status:** Approved
**Origin:** Competitive review of Forge's gates against Devin, Factory, Copilot cloud agent, OpenAI Codex, OpenHands, SWE-agent, Jules, Cursor, Sourcegraph Batch Changes, Dependabot and Renovate. Four defects surfaced. All four are verified in code, not inferred from docs.

## Problem

### P0 — `awaiting_review` means two opposite things

`runAutoMerge` (`apps/web/src/server/tick/auto-merge.ts:48-56`) selects every task with
`status = 'awaiting_review'` and a non-null `prUrl`, then gates only on diff shape
(`evaluatePolicy`, `auto-merge.ts:197-209`: additions, deletions, files changed, path globs).
Verified by grep: it never reads `verdict`, `aiReviewRetryCount`, `verifyRetryCount`, or
`haltReason`.

Seven paths enter `awaiting_review`, and they do not mean the same thing:

| Path | Site | Meaning |
| --- | --- | --- |
| CI green, gates disabled | `gates.ts:18-25` | ready |
| Self-verify passed | `verify.ts:271-296` | ready |
| AI review approved | `ai-review.ts:245-263` | ready |
| AI review rejected 3× | `ai-review.ts:292-316` | needs a human |
| Self-verify incomplete, retries exhausted | `verify.ts:333-360` | needs a human |
| Gate-stall sweep (validator erroring 30 min) | `reconciler.ts:265-296` | unknown state |
| Auto-merge failed, rolled back | `auto-merge.ts:172-188` | needs a human |

A task the AI reviewer rejected three times is therefore auto-merge eligible, and is
squash-merged if its diff is under the configured size. The state that means "stop" is the
state that feeds the merge robot.

### P1 — merge-time gating is reimplemented, and a policy field is a lie

`tryMerge` calls `gh.pulls.merge` (`auto-merge.ts:129-171`) after only the diff-shape check.
Nothing verifies required checks at merge time. Diff size is a proxy for risk, not a check of it.

Separately, `AutoMergePolicy.requiredChecks?: string[]` (`packages/db/src/schema.ts:437`) is
declared and **read by nothing** — confirmed by a repo-wide grep returning only the declaration.
An operator can configure required checks and reasonably believe they are enforced. A silently
inert safety control is worse than an absent one.

Every mature comparable — Dependabot, Renovate, Devin, GitHub Copilot cloud agent — delegates
the merge decision to the code host's branch protection rather than reimplementing it.

### P2 — Forge cannot observe the PR it opened

The webhook handler (`apps/web/src/app/(app)/api/forge/github/webhook/route.ts`) handles only
`issue_comment` and `check_suite`. The GitHub App's live event subscription is
`check_suite, issue_comment, push` (confirmed via `GET /app`). Consequently:

- A human merging or closing the PR on GitHub is never observed. The task remains in
  `awaiting_review` indefinitely, while the parent mission may already have auto-completed —
  `awaiting_review` counts as mission-terminal (`reconciler.ts:52-58,298-331`).
- No `review_decision` is fetched anywhere, which is why `merge-stepper.ts:18-24` documents
  that no Review step can honestly be shown.

### P3 — the review queue has no exit, and the main entry point has no gate

**(a)** No action anywhere in `apps/web/src/app` transitions a task out of `awaiting_review`.
Auto-merge is the only exit. The "Needs You" queue (`home.ts:26`) is a list with no button.

**(b)** `dispatch-from-github.ts:67` creates the mission with `status: 'running'` directly,
skipping `draft → planning → ` human Start. The UI path enforces that gate — the dispatcher
only queries `running` missions (`dispatcher.ts:47`) — so the strongest gate in the product
does not cover `@forge`, its headline entry point.

## Design

### P0 — split the status, record the reason

Remove `awaiting_review` from the task status enum entirely — it is replaced, not supplemented,
so no code path can keep using the ambiguous value:

- **`ready_to_merge`** — the three clean paths. Auto-merge eligible.
- **`needs_human`** — the four escalation paths. Never auto-merge eligible.

Add `escalationReason` to `tasks`, a text column with an enum constraint:
`ai_review_rejected | verify_incomplete | gate_stall | auto_merge_failed`. Null for
`ready_to_merge`. Set by each escalation site.

**Status gates; reason explains.** The reason is diagnostic metadata for the UI — it replaces
digging through `lastError` — but it is never what auto-merge keys on. The gate lives in the
status so the type system enforces it.

Rationale for splitting the enum rather than adding a marker column that auto-merge must check:
the defect being fixed is exactly "a query forgot to check a second field". A marker column
preserves that failure mode for the next query. This mirrors the decision earlier in this
codebase to make `userId` a required parameter of `getMission`/`getTask` rather than an optional
one call sites must remember.

**Mission terminality changes deliberately:**

- `needs_human` remains mission-terminal. A mission with escalated work has done what it can.
- `ready_to_merge` becomes **non**-terminal. A mission must not declare itself complete while
  work is merge-eligible but unmerged.

This affects `MISSION_TERMINAL_TASK_STATUSES` (`reconciler.ts:52-58`) and the related comment at
`apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts:127`.

### P1 — delegate merge gating to GitHub

Replace the `pulls.merge` call with the `enablePullRequestAutoMerge` GraphQL mutation. GitHub
merges when required checks pass; Forge stops owning the decision.

Two conditions guard it:

1. **Refuse when the repo has no required checks configured.** Native auto-merge on an
   unprotected branch merges immediately, which is today's behaviour wearing a better name.
   Surface this as a visible blocked reason (`auto_merge.blocked` ledger event, `lastError`
   set) rather than merging.
2. **Honour `requiredChecks`.** Validate the policy's named checks against the repo's actually
   configured required checks. A policy naming a check the repo does not require is a
   configuration error and blocks, rather than passing silently.

The existing rollback path (merge call fails → back to the review state with `lastError`) is
retained, now targeting `needs_human` with `escalationReason = 'auto_merge_failed'`.

### P2 — subscribe to `pull_request`

Handle these events in the existing webhook route:

- `pull_request.closed` with `merged: true` → task → `merged`.
- `pull_request.closed` with `merged: false` → task → `abandoned`.
- `pull_request_review` submitted/dismissed → persist the decision in a new `reviewDecision`
  column on `tasks`: `approved | changes_requested | commented`, null when never reviewed.

Tasks are located by `prUrl`. Events for PRs Forge did not open are ignored.

This requires updating the GitHub App's subscribed events to include `pull_request` and
`pull_request_review`, which is app configuration, not code. It can be done via the API using
the app JWT, the same mechanism used to repoint the webhook URL.

With a real review decision persisted, the merge stepper gains a third step. Scope is limited to
exactly that: `merge-stepper.ts` grows a Review step between CI and Merge, driven by
`reviewDecision` — pending when null, complete when `approved`, needing attention when
`changes_requested`. The comment at `merge-stepper.ts:18-24` explaining why no such step could
exist is removed. No other stepper or layout change is in scope.

### P3a — actions on `needs_human`

Two server actions, both ownership-scoped through the mission and both writing ledger events
recording the acting user:

- **Approve** → `ready_to_merge`, clears `escalationReason`. Auto-merge may then proceed
  subject to P1's gating.
- **Dismiss** → `abandoned`.

This is the primitive the "Needs You" queue has always lacked, and the equivalent of Renovate's
Dependency Dashboard checkbox.

### P3b — per-repo plan-approval policy

Add `repoPolicy`, a typed JSON column on `github_installation_repos`, mirroring the existing
`autoMergePolicy` pattern:

```ts
export type RepoPolicy = {
  requirePlanApproval: boolean;
};
```

JSON rather than a boolean column so later settings do not each require a migration, and so the
object can later be sourced from versioned config when policy-as-code is built.

**Default: `requirePlanApproval: true`.** When set, `dispatch-from-github.ts` creates the
mission in `draft` and runs the planner to `planning` rather than `running`, and Forge replies
on the issue with a link to approve the plan. When false, current behaviour is preserved.

This is a deliberate behaviour change to the `@forge` flow: a comment produces a plan awaiting
approval rather than an immediate dispatch.

### Optional human-approval gate for auto-merge

Add `requireHumanApproval?: boolean` to `AutoMergePolicy`, defaulting false. When true,
auto-merge only considers tasks a human explicitly approved via P3a. This gives Renovate parity
for operators who want it without making it the default — unattended auto-merge remains a real
feature.

## Migration and backfill

Generated with `pnpm --filter @forge/db db:generate`. Never hand-written: a hand-written
migration (`0004_auth_tables.sql`) was absent from `meta/_journal.json` and therefore never ran
in any environment, including production. The generated file's presence in the journal must be
verified before commit.

**Backfill:** existing `awaiting_review` rows become `needs_human`. Their escalation reason
cannot be reconstructed, so `escalationReason` stays null, and the conservative direction is
chosen deliberately — `needs_human` never auto-merges something that should not have been.

## Testing

Every defect gets a test that fails against today's code:

- A task with `escalationReason` set is not selected by auto-merge.
- A task in `needs_human` is not selected by auto-merge.
- Auto-merge refuses a repo with no required checks configured, and records why.
- A policy naming a check the repo does not require blocks rather than merging.
- `pull_request.closed` with `merged: true` moves the task to `merged`.
- `pull_request.closed` with `merged: false` moves the task to `abandoned`.
- Approve moves `needs_human` → `ready_to_merge` and clears the reason.
- Dismiss moves `needs_human` → `abandoned`.
- With `requirePlanApproval: true`, an `@forge` comment produces a mission in `planning`, and
  the dispatcher does not dispatch it.
- A mission with a `ready_to_merge` task does not auto-complete.

Each is mutation-tested: reverting the fix must fail a specific test. Tests that pass with the
fix reverted do not count as coverage.

## Out of scope

- **Policy as inheritable versioned config.** `repoPolicy` is a single JSON column, not a
  config-file system with preset inheritance. The competitive review identified policy-as-code
  with org-wide inheritance (Renovate's `extends` chain and `renovate-config` convention) as the
  largest structural gap, but it is its own piece of work.
- Renaming the GitHub App from `forge-local-udd8ld`. Changing it changes the slug and breaks
  `GITHUB_APP_SLUG` in `deploy.yml:107`.
- Linking the `agentstep` organisation installation, which exists on GitHub but is not linked in
  Forge.
