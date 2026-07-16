import { randomBytes, randomUUID } from 'node:crypto';

import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import { createDatabase } from './client';
import { missions, tasks } from './schema';

/**
 * One-time backfill: splits each existing standing mission (workspaceRepo
 * set, issueRef null, parentMissionId null, created before those columns
 * existed) into a container (the existing mission row, repurposed —
 * cheaper than deleting it and avoids orphaning its id from any ledger
 * events) plus one new issue leaf mission per distinct issueRef among its
 * tasks, re-pointing those tasks at their new leaf.
 *
 * Run with --dry-run first to see what it would do without writing
 * anything. Idempotent: a mission only qualifies as a candidate if it
 * currently has tasks directly attached AND both issueRef and
 * parentMissionId are still null — once split, the container has zero
 * directly-attached tasks left, so re-running the script is a no-op.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');

  const { db, client } = createDatabase({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

  const candidates = await db
    .select()
    .from(missions)
    .where(
      and(
        isNotNull(missions.workspaceRepo),
        isNull(missions.issueRef),
        isNull(missions.parentMissionId),
      ),
    );

  let containersCreated = 0;
  let leavesCreated = 0;
  let tasksRepointed = 0;

  for (const container of candidates) {
    const ownTasks = await db.select().from(tasks).where(eq(tasks.missionId, container.id));
    if (ownTasks.length === 0) continue; // already a container (or never had tasks) — nothing to split

    const byIssueRef = new Map<string, typeof ownTasks>();
    for (const task of ownTasks) {
      if (!task.issueRef) continue; // defensive: every standing-mission task should have one
      const bucket = byIssueRef.get(task.issueRef) ?? [];
      bucket.push(task);
      byIssueRef.set(task.issueRef, bucket);
    }

    console.log(
      `${dryRun ? '[dry-run] ' : ''}mission ${container.id} (${container.workspaceRepo}): ` +
        `${ownTasks.length} tasks across ${byIssueRef.size} issues`,
    );

    if (dryRun) {
      containersCreated += 1;
      leavesCreated += byIssueRef.size;
      tasksRepointed += ownTasks.length;
      continue;
    }

    await db.transaction(async (tx) => {
      const now = new Date();
      for (const [issueRef, issueTasks] of byIssueRef) {
        const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
        await tx.insert(missions).values({
          id: leafId,
          userId: container.userId,
          name: `Issue — ${issueRef}`,
          goal: `Fix ${issueRef} in ${container.workspaceRepo}.`,
          status: 'running',
          backend: container.backend,
          agentId: container.agentId,
          plannerStrategy: 'rule-based',
          targetRepos: container.targetRepos,
          issueQuery: null,
          concurrencyCap: container.concurrencyCap,
          budgetUsd: null,
          budgetTokens: null,
          budgetThresholdPct: container.budgetThresholdPct,
          budgetHardStopPct: container.budgetHardStopPct,
          taskMaxTurns: container.taskMaxTurns,
          taskMaxTokens: container.taskMaxTokens,
          noProgressTokens: container.noProgressTokens,
          webhookSecret: randomBytes(32).toString('hex'),
          githubInstallationId: container.githubInstallationId,
          githubVaultId: container.githubVaultId,
          skillId: container.skillId,
          aiReviewEnabled: container.aiReviewEnabled,
          selfVerifyEnabled: container.selfVerifyEnabled,
          workspaceRepo: container.workspaceRepo,
          issueRef,
          parentMissionId: container.id,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
        });
        leavesCreated += 1;

        for (const task of issueTasks) {
          await tx.update(tasks).set({ missionId: leafId, updatedAt: now }).where(eq(tasks.id, task.id));
          tasksRepointed += 1;
        }
      }
    });
    containersCreated += 1;
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}done: ${containersCreated} mission(s) split, ` +
      `${leavesCreated} issue leaf mission(s) created, ${tasksRepointed} task(s) re-pointed`,
  );
  client.close();
}

void main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
