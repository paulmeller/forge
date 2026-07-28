import type { Mission, Task } from '@forge/db';

/**
 * The /api/v1 response shapes for the two DB rows this API returns.
 *
 * Before this file, `getMission`/`listMissionsForUser`/`getTask` were
 * `db.select().from(...)` — every column — and the routes handed the row
 * straight to `ok()`. Two consequences:
 *
 *  1. `missions.webhookSecret` (the HMAC key that authenticates inbound
 *     callbacks for that mission — see api/forge/webhook/[missionId]) was in
 *     EVERY mission response: the list, the single get, create, plan, start,
 *     cancel and retry. It is the owner's own secret, so this was never a
 *     cross-account leak, but a machine API that returns a credential on
 *     every call puts it in CLI debug logs, CI job output and shell history,
 *     where its blast radius is no longer the API's to reason about.
 *  2. More importantly: there was no response shape at all, so ANY column
 *     added to `missions` or `tasks` in future was published automatically,
 *     by nobody's decision.
 *
 * ALLOW-LIST, NOT DENY-LIST. The two fail in opposite directions when
 * someone adds a column six months from now. A deny-list (`{...row,
 * webhookSecret: undefined}`) publishes the new column by default: the
 * mistake is silent, immediate, and unbounded — the next credential-shaped
 * column ships to every client the day it lands. An allow-list omits it by
 * default: the mistake is that a field a caller wanted is missing, which
 * surfaces as a bug report, not a disclosure. Choosing the failure you can
 * see over the one you cannot is the whole argument.
 *
 * The residual cost of an allow-list — silently dropping a field somebody
 * meant to expose — is bought back by dto.test.ts, which fails when a
 * `missions`/`tasks` column is neither listed here nor named in the
 * corresponding `…Withheld` array. A new column therefore forces an explicit
 * "expose it or withhold it" decision at review time; it just can't default
 * to "expose".
 */

function pick<T extends object, K extends readonly (keyof T)[]>(
  row: T,
  keys: K,
): Pick<T, K[number]> {
  const out = {} as Pick<T, K[number]>;
  for (const key of keys) out[key] = row[key];
  return out;
}

/** Mission columns /api/v1 publishes, in schema order. */
export const missionResponseFields = [
  'id',
  'userId',
  'name',
  'goal',
  'status',
  'backend',
  'agentId',
  'plannerStrategy',
  'targetRepos',
  'issueQuery',
  'workspaceRepo',
  'issueRef',
  'parentMissionId',
  'nextIssueRefs',
  'concurrencyCap',
  'budgetUsd',
  'budgetTokens',
  'budgetThresholdPct',
  'budgetHardStopPct',
  'spentUsd',
  'spentTokens',
  'autoMergePolicy',
  'githubInstallationId',
  'githubVaultId',
  'skillId',
  'aiReviewEnabled',
  'selfVerifyEnabled',
  'taskMaxTokens',
  'taskMaxTurns',
  'noProgressTokens',
  'createdAt',
  'updatedAt',
  'startedAt',
  'completedAt',
] as const satisfies readonly (keyof Mission)[];

/**
 * Mission columns deliberately withheld. Each entry is a decision, not an
 * oversight — dto.test.ts requires every column to appear in exactly one of
 * these two arrays.
 *
 * `webhookSecret`: the mission's inbound-callback HMAC key. A caller never
 * needs it to drive the mission (the webhook is called BY the backend, not
 * by the CLI), so publishing it buys nothing and spreads a credential.
 *
 * Note what is NOT withheld: `githubVaultId` and `githubInstallationId` are
 * pointers to credentials, not credentials — they are also inputs to
 * createMissionSchema, so a caller that set them must be able to read them
 * back or it cannot tell what it created.
 */
export const missionFieldsWithheld = ['webhookSecret'] as const satisfies readonly (keyof Mission)[];

export type MissionResponse = Pick<Mission, (typeof missionResponseFields)[number]>;

export function toMissionResponse(mission: Mission): MissionResponse {
  return pick(mission, missionResponseFields);
}

export function toMissionResponses(missions: Mission[]): MissionResponse[] {
  return missions.map(toMissionResponse);
}

/**
 * Task columns /api/v1 publishes, in schema order.
 *
 * The `tasks` table was checked column by column rather than assumed: it
 * holds no credential. `sessionId`/`backendSessionRef` are the backend's own
 * session handles and are published deliberately — they are what a CLI
 * correlates its output against, and they authenticate nothing on their own
 * (reaching that session still needs the backend's API key, which lives in
 * server env and is never in a response). Nothing here is withheld, which is
 * why `taskFieldsWithheld` is empty: an empty allow-list complement is a
 * finding on record, not a gap.
 */
export const taskResponseFields = [
  'id',
  'missionId',
  'repo',
  'baseBranch',
  'promptVars',
  'issueRef',
  'kind',
  'verdict',
  'dependsOnIds',
  'status',
  'sessionId',
  'backendSessionRef',
  'prUrl',
  'prNumber',
  'diffAdditions',
  'diffDeletions',
  'filesChanged',
  'retryCount',
  'aiReviewRetryCount',
  'turnCount',
  'lastProgressAt',
  'costTokensAtProgress',
  'verifyRetryCount',
  'lastVerifiedSha',
  'haltReason',
  'escalationReason',
  'reviewDecision',
  'approvedBy',
  'approvedHeadSha',
  'acceptanceCriteria',
  'lastError',
  'costUsd',
  'costTokens',
  'createdAt',
  'updatedAt',
  'dispatchedAt',
  'completedAt',
] as const satisfies readonly (keyof Task)[];

/** See taskResponseFields: the tasks table carries nothing to withhold. */
export const taskFieldsWithheld = [] as const satisfies readonly (keyof Task)[];

export type TaskResponse = Pick<Task, (typeof taskResponseFields)[number]>;

export function toTaskResponse(task: Task): TaskResponse {
  return pick(task, taskResponseFields);
}

export function toTaskResponses(tasks: Task[]): TaskResponse[] {
  return tasks.map(toTaskResponse);
}
