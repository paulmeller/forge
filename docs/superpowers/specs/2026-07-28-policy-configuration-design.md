# Policy Configuration — Design

**Date:** 2026-07-28
**Status:** Approved
**Origin:** Finding I7 of the whole-branch review of `feat/gating-correctness` (merged to `main` at `94e727a`).

## Problem

Three policies are enforced in code and settable by nothing except a database client.

`missions.autoMergePolicy` (typed JSON) carries `enabled`, `maxAdditions`, `maxDeletions`,
`maxFilesChanged`, `requiredChecks`, `allowedPathPatterns` and `requireHumanApproval`. It is read
only by `apps/web/src/server/tick/auto-merge.ts`. A repo-wide grep finds no writer.

`github_installation_repos.repoPolicy` (typed JSON) carries `requirePlanApproval`, read by
`apps/web/src/lib/repo-policy.ts`. No writer exists outside a test helper.

The consequence is not cosmetic. `runAutoMerge` bails at `if (!policy?.enabled) continue;`, and
nothing can set `enabled`, so **auto-merge is dead code for every user**. The gating branch's
headline feature cannot be switched on. The same branch made a policy-less mission treat
`ready_to_merge` as mission-terminal, which is correct and keeps missions from wedging — but it
means the clean path now ends in a state only a human can clear, permanently, for everyone.

## Design

### Editing surface: extend the existing repo Settings tab

`apps/web/src/app/(app)/repos/[owner]/[repo]/settings-tab.tsx` and its server action
`settings-actions.ts` already exist and already edit repo-level configuration —
`concurrencyCap`, `budgetUsd`, `aiReviewEnabled`, `selfVerifyEnabled`. `updateRepoSettings`
writes the repo's **container mission** row, scoped by `and(eq(missions.id, containerId),
eq(missions.userId, user.id))`.

Policy fields are added to that tab and that action. No new page, no new route, no new
authorisation model: repo-owner-only falls out of the ownership scoping the action already
enforces. A Server Action is a POST endpoint reachable without rendering the page, so that
scoping is the only guard and must not be weakened.

### `autoMergePolicy`: live container inheritance

`autoMergePolicy` is already a column on `missions`, and a repo's container is a mission — so a
repo-level policy needs no new storage. Issue-leaf missions resolve it by reading their
container, exactly as `resolveGateFlags` (`apps/web/src/server/tick/gate-flags.ts:19`) already
does for `aiReviewEnabled` / `selfVerifyEnabled`.

Add `resolveAutoMergePolicy(missionId): Promise<AutoMergePolicy | null>` beside
`resolveGateFlags`, following its structure precisely:

- Read the mission's own `autoMergePolicy` and `parentMissionId`.
- No row → return null.
- `parentMissionId` set and the parent exists → return the **parent's** policy.
- Otherwise → return the row's own policy.

`auto-merge.ts` calls it instead of reading `row.mission.autoMergePolicy` directly.

`reconciler.ts`'s `missionTerminalStatusesFor` decides whether `ready_to_merge` holds a mission
open, and must agree with auto-merge about whether a policy exists — otherwise a leaf mission
would be treated as terminal by the reconciler while auto-merge still intends to merge it, or
vice versa. It is currently pure (`Pick<Mission, 'autoMergePolicy'>`, exported for testing) and
**stays pure**: change its parameter from the mission row to the already-resolved
`AutoMergePolicy | null`, and have its caller in `runReconciler` do the resolution via
`resolveAutoMergePolicy`. The resolution happens once, at the caller, in both subsystems; the
decision function remains a pure, directly-testable mapping.

**Live lookup, not copy-at-creation.** This matches the established pattern, and is the better
semantics here: enabling auto-merge on a repo immediately unsticks every mission already sitting
in `ready_to_merge`. Copy semantics would strand exactly the tasks the wedge fix made visible,
and would require touching all five mission-creation sites.

### `repoPolicy` stays where it is

`requirePlanApproval` is consulted by `dispatch-from-github.ts` to decide what status a mission is
*created* with, so it cannot live on a mission that does not yet exist. It stays on
`github_installation_repos`. The Settings tab writes both tables within one action; that is an
implementation detail, not a leaked abstraction.

### Fields exposed

| Field | Control | Blank/off means |
| --- | --- | --- |
| `enabled` | Switch | Auto-merge never runs (current behaviour for everyone) |
| `maxAdditions` | Number | No additions cap |
| `maxDeletions` | Number | No deletions cap |
| `maxFilesChanged` | Number | No files-changed cap |
| `allowedPathPatterns` | Textarea, one glob per line | No path restriction |
| `requiredChecks` | Textarea, one check name per line | Branch protection alone decides |
| `requireHumanApproval` | Switch | Approval not required |
| `requirePlanApproval` | Switch | `@forge` dispatches immediately |

Validation mirrors the existing action's style (explicit checks returning
`{ ok: false, error }`, not exceptions): numeric caps are positive integers or blank; textarea
lines are trimmed with blanks dropped; an empty list is stored as omitted rather than `[]`, so
"unset" and "empty" do not diverge in meaning.

`requiredChecks` names checks the branch must require. `auto-merge.ts` already blocks when a
named check is not in the branch's actual required set, so a typo surfaces as a visible blocked
reason rather than a silent pass.

### Defaults

`requireHumanApproval` defaults **off**. Auto-merge is opt-in already; enabling it and then
having nothing merge until each task is separately approved reads as broken. Renovate's
`dependencyDashboardApproval` defaults false for the same reason.

`requirePlanApproval` stays **on**, as shipped. It fails closed on malformed data via
`getRepoPolicy`, and that behaviour is pinned by four mutation-killed tests. Do not weaken it.

## Out of scope

**Policy as versioned config.** A `.forge/policy.yml` read from the target repo, with an
`extends` chain and org-wide inheritance, is the mature answer a competitive review identified as
Forge's largest structural gap against Renovate. The typed JSON columns this design writes are
the right shape to later be *sourced* from such a file, which is why this work does not preclude
it. It is a separate project.

**Org and role models.** Ownership stays per-user via `missions.userId`. Multi-user orgs, roles,
and separation of duties are not addressed. Note plainly in the UI copy that
`requireHumanApproval` permits self-approval — the mission owner may approve their own task. It
is a "a human looked" control, not four-eyes.

## Testing

- `resolveAutoMergePolicy` returns the container's policy for a leaf, the row's own for a
  standalone mission, and null for a missing row — mirroring `gate-flags.test.ts`.
- Enabling auto-merge on a container makes an existing leaf's `ready_to_merge` task
  auto-merge-eligible without recreating the mission — the live-lookup property.
- `missionTerminalStatusesFor` and `auto-merge.ts` agree about a leaf's policy; a test that fails
  if either reads the row directly instead of resolving.
- `updateRepoSettings` rejects another user's container (ownership), and rejects invalid numeric
  caps.
- Round-trip: values entered in the form are what `auto-merge.ts` reads.
- Blank textareas store omitted, not `[]`.

Every behaviour is mutation-tested: revert the change, confirm a specific named test fails,
restore. Mutation results are reported per behaviour, never bundled — a bundled report on the
previous branch misattributed which assertion failed and cost a review round.
