import { randomBytes, randomUUID } from 'node:crypto';

import { and, asc, eq, notInArray } from 'drizzle-orm';

import {
  githubInstallationRepos,
  githubInstallations,
  ledgerEvents,
  missions,
  tasks,
  type Mission,
  type MissionStatus,
} from '@forge/db';

import { db } from './db';
import { env } from './env';
import { getOctokitClient } from './octokit';
import { runPlanner } from './planner';
import { DEFAULT_REPO_POLICY, getRepoPolicy } from './repo-policy';
import { REPO_LOCATION_HINT } from './repo-hint';

export type GithubDispatchInput = {
  repoFullName: string; // 'owner/repo'
  defaultBranch: string;
  goal: string; // free-form text from the comment
  issueRef?: string; // 'owner/repo#123'
  triggeredBy: string; // GitHub login of the commenter
  /**
   * GitHub's own numeric installation id — the `installation.id` field GitHub
   * includes in every GitHub-App-delivered webhook payload (verified by the
   * webhook route's HMAC check before this function ever sees it, so it
   * cannot be forged by anything but GitHub itself).
   *
   * C2: `github_installation_repos` rows are looked up by bare repo name,
   * but the unique index on that table is (installationId, repo) — not repo
   * alone — so two different installations (e.g. a stale, orphaned
   * installation from a prior uninstall/reinstall cycle, and the current
   * live one) can each hold a row for the identical repo string. There is no
   * interactive session here to resolve "whose installation" the way a
   * signed-in caller would, so this field is that resolution: it names the
   * specific installation GitHub says delivered *this* event, which is the
   * only trustworthy answer to "which row applies" when more than one
   * exists. Omitting it (or a repo/installation combination that resolves to
   * no row) fails closed to `DEFAULT_REPO_POLICY` and the system-default
   * owner/agent/vault, rather than falling back to an unscoped,
   * cross-tenant read.
   */
  installationId?: number;
  /**
   * Bypasses the repo's `requirePlanApproval` gate for this one dispatch.
   *
   * I4: this exists for exactly one caller — the webhook route's
   * `handleCheckSuite` (self-healing CI-fix dispatch). The plan-approval
   * gate's whole point is that an `@forge`/`/forge` comment is a *human*
   * asking Forge to start new work, so a human should see and approve the
   * plan first. A failing check suite is Forge reacting to its own PR going
   * red — nobody asked for new work, there is no new "plan" to show, and
   * gating it just means every red CI run posts another "approve this"
   * comment on the same PR and piles up an unbounded stack of unapproved
   * draft missions that never self-heal anything.
   *
   * This is a deliberate, narrow exemption for that one self-triggered
   * fix loop — not a general escape hatch. Don't default it to true, and
   * don't add a second caller without re-reading this comment; if a repo
   * needs finer-grained control over this later, that argues for a
   * dedicated repo-policy field (e.g. `autoFixCi`), not for widening what
   * this flag is used for.
   */
  bypassPlanApprovalGate?: boolean;
  /**
   * GitHub's `X-GitHub-Delivery` header — a fresh GUID GitHub mints per
   * webhook delivery attempt, reused on a redelivery of that same attempt.
   * Optional because not every caller has one (e.g. a future non-webhook
   * caller), but the webhook route always has and always passes it.
   *
   * #41: without this, a GitHub retry (or two concurrent Cloud Run
   * invocations processing the same delivery) each called this function
   * independently and each got their own Mission. See
   * `findExistingGithubDispatch` below for how this and `issueRef` are used
   * together to close that gap.
   */
  githubDeliveryId?: string;
};

export type GithubDispatchResult = {
  mission: Mission;
  taskId: string;
};

// GitHub-dispatched missions use a system user ID since there's no
// authenticated session context in webhook handlers.
const GITHUB_SYSTEM_USER_ID = 'user_default';

/**
 * A Mission in one of these can never receive new webhook-driven work for
 * its issue again — the only two settled members of `missionStatus`.
 * Everything else (draft/planning/running/paused) is still "in flight" and
 * is exactly what #41's (repo, issueRef) guard must refuse to duplicate.
 */
const MISSION_TERMINAL_STATUSES: MissionStatus[] = ['completed', 'cancelled'];

/**
 * The Task a completed/in-flight `dispatchFromGithub` call for this Mission
 * already created — by construction there is exactly one (the "one-Task
 * Mission" invariant the gated/ungated branches below both preserve), so the
 * earliest by createdAt is unambiguous. Used only to shape a dedup hit into
 * the same `GithubDispatchResult` a fresh dispatch would have returned.
 */
async function firstTaskIdFor(missionId: string): Promise<string> {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.missionId, missionId))
    .orderBy(asc(tasks.createdAt))
    .limit(1);
  return task?.id ?? '';
}

/**
 * #41: checks both idempotency guards before a new Mission is created —
 * a redelivery of the same `X-GitHub-Delivery`, and a second dispatch for a
 * (repo, issueRef) that already has a non-terminal Mission. Returns the
 * existing dispatch's result if either matches, or null to let the caller
 * proceed with a fresh dispatch.
 *
 * This is a plain read, not itself race-proof — the delivery-id case gets a
 * hard backstop from `missions_github_delivery_unique_idx` at insert time
 * (see the `onConflictDoNothing` in the transaction below); the issueRef
 * case does not, since "one non-terminal Mission per issue" isn't expressible
 * as a static unique index. In practice this still closes the reported bug:
 * GitHub retries and double-comments arrive as separate HTTP requests
 * seconds apart, never as literally-simultaneous inserts.
 *
 * The issueRef check joins through `tasks`, not a `missions.issueRef` column
 * — this function deliberately never sets one (see the mission insert
 * below), because `mission-shape.ts`'s `isIssueMission` reads that column to
 * decide how a Mission is labelled/grouped in the console, and a webhook
 * dispatch is not the issue-leaf Mission shape that column means. `tasks.
 * issueRef` already carries the same value (set by both the gated and
 * ungated branches below) without that side effect.
 */
async function findExistingGithubDispatch(
  input: GithubDispatchInput,
): Promise<GithubDispatchResult | null> {
  if (input.githubDeliveryId) {
    const [existing] = await db
      .select()
      .from(missions)
      .where(eq(missions.githubDeliveryId, input.githubDeliveryId))
      .limit(1);
    if (existing) return { mission: existing, taskId: await firstTaskIdFor(existing.id) };
  }

  if (input.issueRef) {
    const [existing] = await db
      .select({ mission: missions })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .where(
        and(
          eq(tasks.issueRef, input.issueRef),
          notInArray(missions.status, MISSION_TERMINAL_STATUSES),
        ),
      )
      .orderBy(asc(missions.createdAt))
      .limit(1);
    if (existing) return { mission: existing.mission, taskId: await firstTaskIdFor(existing.mission.id) };
  }

  return null;
}

/**
 * Spawns a one-Task Mission scoped to a single repo, kicked off by a
 * GitHub @-mention or reaction.
 *
 * Whether it runs immediately depends on the repo's `requirePlanApproval`
 * policy, which defaults to true. An @-mention is a request, not plan
 * approval — the UI path has always required a human to review the plan
 * before dispatch, and this is what stops @forge being the one way in that
 * skips that gate. `input.bypassPlanApprovalGate` (see its doc comment on
 * `GithubDispatchInput`) is the one deliberate exception.
 */
export async function dispatchFromGithub(
  input: GithubDispatchInput,
): Promise<GithubDispatchResult> {
  // #41: a redelivery of the same webhook event, or two comments/deliveries
  // racing for the same issue, must not each spawn their own Mission. Two
  // guards, per the issue's "prefer both": the delivery id catches a retry of
  // the *exact* same event; the (repo, issueRef) pair catches a genuine
  // double-comment or a redelivery GitHub happened to mint a new id for.
  // Order matters only for which existing Mission wins when both would
  // match — the delivery id is the more precise signal, so it's checked
  // first.
  const existing = await findExistingGithubDispatch(input);
  if (existing) return existing;

  // C2: both this policy lookup and the repoRow lookup just below must
  // resolve against the SAME installation, or a repo dispatch could read its
  // gate from one tenant's row while picking its owner/agent/vault from
  // another's. See the doc comment on `installationId` (GithubDispatchInput,
  // above) for why the numeric GitHub installation id from the webhook
  // payload is the safe, authoritative resolver here.
  //
  // No installation id at all means this call cannot safely resolve a
  // specific tenant's row — fail closed to the gated default rather than an
  // unscoped, cross-tenant read.
  const policy =
    input.installationId !== undefined
      ? await getRepoPolicy(input.repoFullName, input.installationId)
      : DEFAULT_REPO_POLICY;
  // I4: the CI-fix path (handleCheckSuite) opts out of the gate explicitly;
  // every other caller (the @forge comment path) goes through the policy
  // unchanged.
  const gated = policy.requirePlanApproval && !input.bypassPlanApprovalGate;
  const now = new Date();
  const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const ledgerSeed = `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

  // Look up the repo owner from github_installation_repos, scoped to the
  // same installation the policy above was just resolved against.
  const [repoRow] =
    input.installationId !== undefined
      ? await db
          .select({
            userId: githubInstallations.userId,
            agentId: githubInstallations.agentId,
            githubVaultId: githubInstallations.githubVaultId,
          })
          .from(githubInstallationRepos)
          .innerJoin(
            githubInstallations,
            eq(githubInstallationRepos.installationId, githubInstallations.id),
          )
          .where(
            and(
              eq(githubInstallationRepos.repo, input.repoFullName),
              eq(githubInstallations.installationId, input.installationId),
            ),
          )
          .limit(1)
      : [];

  const userId = repoRow?.userId ?? GITHUB_SYSTEM_USER_ID;
  const agentId = repoRow?.agentId ?? env.FORGE_DEFAULT_AGENT_ID ?? 'agent_unset';
  const githubVaultId = repoRow?.githubVaultId ?? env.FORGE_DEFAULT_GITHUB_VAULT_ID ?? null;

  const created = await db.transaction(async (tx) => {
    const [mission] = await tx
      .insert(missions)
      .values({
        id: missionId,
        userId,
        name: `GH: ${input.repoFullName} — ${input.goal.split('\n')[0]?.slice(0, 60) ?? 'mission'}`,
        goal: `${REPO_LOCATION_HINT}\n\n${input.goal}`,
        status: gated ? 'draft' : 'running',
        backend: env.FORGE_BACKEND,
        agentId,
        plannerStrategy: 'rule-based',
        targetRepos: [input.repoFullName],
        concurrencyCap: 1,
        budgetUsd: null,
        budgetTokens: null,
        budgetThresholdPct: 80,
        webhookSecret: randomBytes(32).toString('hex'),
        githubInstallationId: 'gh-webhook',
        githubVaultId,
        githubDeliveryId: input.githubDeliveryId ?? null,
        createdAt: now,
        updatedAt: now,
        startedAt: gated ? null : now,
      })
      // #41 backstop: the `findExistingGithubDispatch` read above closes the
      // gap for sequential retries, but two truly concurrent invocations of
      // the identical delivery could both pass that read before either
      // commits. `missions_github_delivery_unique_idx` (schema.ts) is what
      // makes that race safe — onConflictDoNothing turns the loser's insert
      // into a no-op instead of a thrown constraint error, and the branch
      // below reads back the winner's row instead of erroring the request.
      .onConflictDoNothing({ target: [missions.githubDeliveryId] })
      .returning();

    if (!mission) {
      if (!input.githubDeliveryId) {
        throw new Error('mission insert returned no rows');
      }
      const [winner] = await tx
        .select()
        .from(missions)
        .where(eq(missions.githubDeliveryId, input.githubDeliveryId))
        .limit(1);
      if (!winner) throw new Error('lost the delivery-id race but no winner row exists');
      return { mission: winner, taskId: null as string | null, raced: true as const };
    }

    await tx.insert(ledgerEvents).values({
      id: ledgerSeed,
      missionId: mission.id,
      eventType: 'mission.created_from_github',
      payload: {
        repo: input.repoFullName,
        issueRef: input.issueRef,
        triggeredBy: input.triggeredBy,
        goal: input.goal,
      },
      createdAt: now,
    });

    // Gated: leave the Mission in `draft` with no Tasks — runPlanner (called
    // below, once the transaction has committed) is what creates them.
    // Inserting a placeholder Task here too would leave a gated Mission with
    // two Tasks, breaking the "one-Task Mission" invariant this function's
    // callers (and the dispatcher) rely on.
    if (gated) {
      return { mission, taskId: null as string | null, raced: false as const };
    }

    const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await tx.insert(tasks).values({
      id: taskId,
      missionId: mission.id,
      repo: input.repoFullName,
      baseBranch: input.defaultBranch,
      promptVars: { repo: input.repoFullName, base_branch: input.defaultBranch },
      issueRef: input.issueRef ?? null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(ledgerEvents).values([
      {
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: mission.id,
        taskId,
        eventType: 'planner.emitted',
        payload: {
          strategy: 'rule-based',
          taskIds: [taskId],
          repoCount: 1,
          source: 'github',
        },
        createdAt: now,
      },
      {
        id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        missionId: mission.id,
        eventType: 'mission.started',
        payload: { from: 'planning', to: 'running', source: 'github' },
        createdAt: now,
      },
    ]);

    return { mission, taskId, raced: false as const };
  });

  if (created.raced) {
    // Lost the delivery-id race (see the onConflictDoNothing comment above)
    // — the winner already ran this function's full flow, plan-approval
    // comment included, for this exact delivery. Report their result rather
    // than redoing any of it.
    return { mission: created.mission, taskId: await firstTaskIdFor(created.mission.id) };
  }

  if (!gated) {
    // created.taskId is always set on this branch (see above).
    return { mission: created.mission, taskId: created.taskId! };
  }

  // Plan now so the operator reviews real Tasks rather than an empty
  // mission; startMission() remains the only path to `running`. Pass the
  // same baseBranch/issueRef the ungated path writes directly — otherwise
  // the rule-based Planner's generic defaults ('main', no issue) silently
  // diverge from what the webhook payload actually said.
  const plan = await runPlanner(created.mission.id, {
    baseBranch: input.defaultBranch,
    issueRef: input.issueRef ?? null,
  });
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.missionId, created.mission.id))
    .limit(1);
  await commentPlanLink(input, created.mission.id);

  return { mission: plan.mission, taskId: task?.id ?? '' };
}

const ISSUE_REF_RE = /^([^/]+)\/([^#]+)#(\d+)$/;

/**
 * Tells the commenter where to approve the plan. Best-effort: a failure to
 * comment must not undo a Mission that was created successfully, so this
 * swallows errors rather than throwing into the dispatch path.
 */
async function commentPlanLink(input: GithubDispatchInput, missionId: string): Promise<void> {
  if (!input.issueRef) return;
  if (!env.GITHUB_APP_TOKEN) return;
  // BETTER_AUTH_URL always resolves to *something* (it falls back to
  // localhost so unrelated code paths don't need it configured), so it can
  // never be falsy here — checking truthiness can't detect a forgotten
  // config. A comment built from the localhost fallback would ship a dead
  // link to a real GitHub user, so require it to have actually been set.
  if (!env.BETTER_AUTH_URL_IS_CONFIGURED) return;
  const m = ISSUE_REF_RE.exec(input.issueRef);
  if (!m) return;
  const [, owner, repo, numStr] = m;
  try {
    await getOctokitClient().issues.createComment({
      owner: owner!,
      repo: repo!,
      issue_number: Number(numStr),
      body:
        `Planned this mission. Review and approve it to start: ` +
        `${env.BETTER_AUTH_URL}/missions/${missionId}/plan`,
    });
  } catch {
    // Non-fatal — the Mission exists and is visible in the UI regardless.
  }
}

/**
 * Parse a comment body for the @forge directive. Returns the goal text or
 * null if the comment isn't a Forge command.
 *
 * Supported shapes:
 *   "@forge bump fast-glob to ^3.3.2"
 *   "/forge add OTel spans to every HTTP handler"
 */
const TRIGGER = /^\s*(?:@forge|\/forge)\b\s*(.*)$/i;

export function parseForgeDirective(body: string | null | undefined): string | null {
  if (!body) return null;
  // Allow the directive to be on any line of the comment.
  for (const line of body.split(/\r?\n/)) {
    const m = TRIGGER.exec(line);
    if (m && m[1] && m[1].trim().length > 0) return m[1].trim();
  }
  return null;
}
