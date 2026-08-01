# `.forge/policy.yml` and the safe-first-run onboarding gate — Design

**Date:** 2026-08-01
**Status:** Approved
**Closes:** #40. Lands the foundation of #39 (file as source of truth); the
inheritance layer stays open.
**Base:** `main` @ 1176 tests green

## Problem

Two gaps, and they share one answer.

**Connecting a repo is a leap of faith (#40).** Today a repo becomes eligible
for dispatch the moment it is connected. The operator's first evidence of what
Forge will do is a pull request against their code. Renovate is the only product
in the surveyed set with a formal no-risk onboarding gate: it opens a config PR
and makes no further change until that PR merges. Consent arrives before action,
and reviewing the PR *is* the configuration step.

**Policy is invisible and unreviewable (#39).** A repo's gates, auto-merge rules
and budgets live as JSON in `github_installation_repos.repo_policy` and across
mission columns. There is no diff, no history, no review — the settings that
decide whether an agent's work merges without a human cannot themselves be
reviewed by one.

Renovate's onboarding PR works because it proposes the actual config file:
merging it is both consent and configuration. Forge's equivalent therefore
requires the file to exist first, which is why these land together.

## Decisions

### The file is the whole policy, or it is absent

When `.forge/policy.yml` exists on the default branch it is the complete policy
for that repo. The Settings page renders it read-only with a link to the file.

Not a field-by-field merge with database values. A merge model means the
effective policy lives in neither place and "what is my policy?" requires
reading two sources that can disagree — which is drift, the failure this design
exists to remove. This session already paid for that lesson: #66 was two
instruction channels disagreeing, and it silently discarded a completed fix.

The choice is also one-way. A future flow where the Settings page stays editable
and saving opens a PR against the file (the nicest ergonomics) is **additive**
on top of file-authoritative. Starting from a merge model and tightening later
would be a regression.

### One reader, one precedence rule

`resolveRepoPolicy(repo)` returns the effective policy: **file → database →
built-in defaults**, whole-object at each step. It is fetched with the GitHub App
token and cached per tick, exactly as `agents-md.ts` already does for the agent
contract.

This replaces the scattered reads — `resolveAutoMergePolicy`, the `repo_policy`
column, the mission-level gate flags — with one call. That consolidation is most
of the work and most of the durable value: policy currently resolves differently
depending on which code path asks, which is how #34 (an `@forge` mission reading
its own permanently-unset column) happened at all.

### The gate is one guard in one place

A newly connected repo is `pending_onboarding`. Forge opens a PR proposing
`.forge/policy.yml`, pre-filled with safe defaults — auto-merge **off**, every
gate **on** — and the detected stack's verify commands. **The dispatcher refuses
to claim tasks for a repo in that state**, enforced in `claimNextBatch`, which
every dispatch already funnels through. One guard, not a status list to keep in
sync with the state machine.

When the tick observes the file on the default branch, the repo becomes active.
Merging the PR *is* the consent — no separate approval, no second switch.

### Absence is a signal, not an accident

A repo whose policy file is later deleted returns to `pending_onboarding` rather
than silently falling back to database policy. Deleting the file that authorises
autonomous work should stop autonomous work.

An unparseable or schema-invalid file blocks dispatch and surfaces the parse
error on the repo page. It never falls back to defaults: a typo in `autoMerge`
must not quietly enable a gate the operator believed they had configured.

## Components

- **`packages/db/src/schema.ts`** — `github_installation_repos` gains
  `onboardingState` (`pending_onboarding` | `active`) and `onboardingPrUrl`.
  Requires a generated migration.
- **`apps/web/src/lib/policy-file.ts`** (new) — the Zod schema for
  `.forge/policy.yml` and a pure `parsePolicyFile(yaml)` returning a policy or a
  structured error. Pure, so the format is testable without GitHub.
- **`apps/web/src/lib/repo-policy.ts`** (new) — `resolveRepoPolicy(repo)`:
  fetch, parse, apply precedence, cache per tick. The single entry point.
- **`apps/web/src/server/tick/onboarding.ts`** (new) — opens the proposal PR for
  `pending_onboarding` repos, and flips them to `active` when the file appears
  on the default branch. A tick stage, following the existing stage shape.
- **`apps/web/src/server/tick/dispatcher.ts`** — `claimNextBatch` skips repos
  not `active`.
- **`apps/web/src/server/tick/auto-merge-policy.ts`** — `resolveAutoMergePolicy`
  delegates to `resolveRepoPolicy` rather than reading columns itself.
- **`apps/web/src/app/(app)/repos/[owner]/[repo]/settings-tab.tsx`** — read-only
  rendering when a file is present, with a link to it and to the onboarding PR
  while pending.
- **`apps/web/src/app/(app)/setup/actions.ts`** — connecting a repo sets
  `pending_onboarding`.

## Migration and compatibility

Repos connected before this ships are grandfathered `active` in the migration.
An existing deployment must not stop dispatching on upgrade, and existing
operators have already given consent by using the product.

Their database policy keeps working: with no file present, precedence falls
through to the database exactly as today. Adopting the file is opt-in per repo,
and adopting it is irreversible only in the sense that deleting it re-gates the
repo — which is the intended meaning.

## Error handling

- **File absent** → database, then defaults. For a `pending_onboarding` repo,
  absence is also what keeps the gate closed.
- **File unparseable / schema-invalid** → dispatch blocked, error surfaced on
  the repo page, never a silent fallback.
- **GitHub unreachable while resolving** → propagate, do not treat as absent.
  "Could not tell" must not become "no policy", the same rule the completion
  check follows (#76's sibling lesson from `checkForgeBranch`).
- **PR already open** → do not open a second; record and reuse the existing URL.
- **Operator closes the PR without merging** → repo stays `pending_onboarding`.
  Declining is a valid answer and must be sticky, not retried every tick.

## Testing

- `parsePolicyFile` — valid file, unknown key, wrong type, empty file; each
  asserting the structured error rather than a thrown string.
- `resolveRepoPolicy` — file present wins whole-object over database; file
  absent falls through; invalid file errors rather than defaulting; GitHub
  failure propagates.
- `claimNextBatch` — claims nothing for a `pending_onboarding` repo, claims
  normally for `active`. Mutation: removing the guard must fail this test.
- Onboarding stage — opens one PR and only one; flips to `active` when the file
  appears; stays pending when the PR is closed unmerged; re-gates when a file
  is deleted.
- Migration — an existing connected repo is `active` afterwards.
- Every behaviour mutation-tested per the project convention: revert, confirm a
  specific named test fails, restore, source printed.

## Out of scope

- **`extends` chains and org-wide shared config repos** (the rest of #39). The
  fleet-ergonomics layer; additive on this foundation.
- **UI edits writing back a PR.** The best ergonomics, and explicitly deferred:
  it needs PR authoring, conflict handling and pending-change state, none of
  which the launch requires.
- **Per-mission policy overrides.** Repo-level only for now.
