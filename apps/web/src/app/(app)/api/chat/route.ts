import { randomBytes, randomUUID } from 'node:crypto';

import { anthropic } from '@ai-sdk/anthropic';
import { stepCountIs, streamText } from 'ai';
// Import drizzle helpers from @forge/db's own drizzle-orm instance to avoid
// duplicate-package type mismatches with the ai-sdk's transitive drizzle copy.
import { desc, eq, sql } from '@forge/db/orm';
import { z } from 'zod';

import {
  githubInstallationRepos,
  githubInstallations,
  ledgerEvents,
  missions,
  tasks,
} from '@forge/db';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { withAuth } from '@/lib/with-auth';

export const maxDuration = 120;

const SYSTEM_PROMPT = `You are Forge, an autonomous fleet orchestrator. You help users manage coding agents that work across their GitHub repositories.

You can:
- Create missions that dispatch agents to write code, fix bugs, and open PRs
- Check on the status of running missions
- List connected repos
- Cancel missions

When a user asks you to do something to their codebase, create a mission for it. Be concise and direct. When reporting status, use concrete numbers (PRs merged, agents running, dollars spent).

If the user hasn't connected any repos yet, suggest they visit /setup first.`;

export async function POST(req: Request) {
  const user = await withAuth();
  const { messages } = await req.json();

  const userId = user.id;

  const result = streamText({
    model: anthropic('claude-sonnet-4-5-20250514'),
    system: SYSTEM_PROMPT,
    messages,
    stopWhen: stepCountIs(5),
    tools: {
      create_mission: {
        description:
          'Create and dispatch a mission. An agent will clone the repo, do the work, and open a PR.',
        inputSchema: z.object({
          goal: z.string().describe('What the agent should do.'),
          repo: z
            .string()
            .optional()
            .describe('Target repo in owner/repo format. Uses default if omitted.'),
        }),
        execute: async ({ goal, repo: targetRepo }: { goal: string; repo?: string }) => {
          const resolvedRepo = targetRepo ?? (await getDefaultRepo(userId));
          if (!resolvedRepo) {
            return { error: 'No connected repos. Visit /setup to connect GitHub repos.' };
          }

          const agentId = env.FORGE_DEFAULT_AGENT_ID ?? 'agent_unset';
          const githubVaultId = env.FORGE_DEFAULT_GITHUB_VAULT_ID ?? null;
          const now = new Date();
          const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
          const taskId = `tsk_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

          await db.transaction(async (tx) => {
            await tx.insert(missions).values({
              id: missionId,
              userId,
              name: goal.split('\n')[0]?.slice(0, 80) ?? 'mission',
              goal: `IMPORTANT: The repo is cloned at /mnt/session/resources/repo_0 — cd there first.\n\n${goal}`,
              status: 'running',
              backend: env.FORGE_BACKEND,
              agentId,
              plannerStrategy: 'rule-based',
              targetRepos: [resolvedRepo],
              concurrencyCap: 1,
              webhookSecret: randomBytes(32).toString('hex'),
              githubInstallationId: 'chat',
              githubVaultId,
              createdAt: now,
              updatedAt: now,
              startedAt: now,
            });

            await tx.insert(tasks).values({
              id: taskId,
              missionId,
              repo: resolvedRepo,
              baseBranch: 'main',
              promptVars: { repo: resolvedRepo, base_branch: 'main' },
              status: 'queued',
              createdAt: now,
              updatedAt: now,
            });

            await tx.insert(ledgerEvents).values({
              id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
              missionId,
              eventType: 'mission.created_from_chat',
              payload: { goal, repo: resolvedRepo, triggeredBy: userId },
              createdAt: now,
            });
          });

          return { missionId, taskId, repo: resolvedRepo, status: 'dispatched', missionUrl: `/missions/${missionId}` };
        },
      },

      get_mission: {
        description: 'Get the status of a specific mission.',
        inputSchema: z.object({
          missionId: z.string().describe('The mission ID (msn_...)'),
        }),
        execute: async ({ missionId }: { missionId: string }) => {
          const rows = await db
            .select()
            .from(missions)
            .where(sql`${missions.id} = ${missionId} AND ${missions.userId} = ${userId}`)
            .limit(1);
          const mission = rows[0];
          if (!mission) return { error: 'Mission not found' };

          const missionTasks = await db
            .select()
            .from(tasks)
            .where(sql`${tasks.missionId} = ${missionId}`);

          return {
            id: mission.id,
            name: mission.name,
            status: mission.status,
            backend: mission.backend,
            createdAt: mission.createdAt,
            tasks: missionTasks.map((t) => ({
              id: t.id,
              repo: t.repo,
              status: t.status,
              prUrl: t.prUrl,
            })),
          };
        },
      },

      list_missions: {
        description: 'List recent missions for the current user.',
        inputSchema: z.object({
          status: z
            .enum(['running', 'completed', 'failed', 'paused', 'cancelled', 'draft', 'planning'])
            .optional()
            .describe('Filter by status'),
        }),
        execute: async ({ status }: { status?: string }) => {
          const rows = status
            ? await db
                .select()
                .from(missions)
                .where(sql`${missions.userId} = ${userId} AND ${missions.status} = ${status}`)
                .orderBy(desc(missions.createdAt))
                .limit(10)
            : await db
                .select()
                .from(missions)
                .where(sql`${missions.userId} = ${userId}`)
                .orderBy(desc(missions.createdAt))
                .limit(10);

          return {
            count: rows.length,
            missions: rows.map((m) => ({
              id: m.id,
              name: m.name,
              status: m.status,
              backend: m.backend,
              createdAt: m.createdAt,
            })),
          };
        },
      },

      list_repos: {
        description: 'List repos connected to the current user.',
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const repos = await db
              .select({ repo: githubInstallationRepos.repo })
              .from(githubInstallationRepos)
              .innerJoin(
                githubInstallations,
                eq(githubInstallationRepos.installationId, githubInstallations.id),
              )
              .where(eq(githubInstallations.userId, userId));

            return { count: repos.length, repos: repos.map((r) => r.repo) };
          } catch {
            return { count: 0, repos: [] };
          }
        },
      },

      cancel_mission: {
        description: 'Cancel a running mission.',
        inputSchema: z.object({
          missionId: z.string().describe('The mission ID to cancel'),
        }),
        execute: async ({ missionId }: { missionId: string }) => {
          const rows = await db
            .select()
            .from(missions)
            .where(sql`${missions.id} = ${missionId} AND ${missions.userId} = ${userId}`)
            .limit(1);
          const mission = rows[0];

          if (!mission) return { error: 'Mission not found' };
          if (mission.status !== 'running' && mission.status !== 'paused') {
            return { error: `Cannot cancel mission in "${mission.status}" status` };
          }

          const now = new Date();
          await db
            .update(missions)
            .set({ status: 'cancelled', updatedAt: now, completedAt: now })
            .where(sql`${missions.id} = ${missionId}`);

          await db
            .update(tasks)
            .set({ status: 'abandoned', updatedAt: now, completedAt: now })
            .where(
              sql`${tasks.missionId} = ${missionId} AND ${tasks.status} IN ('queued', 'dispatching', 'running', 'turn_ended')`,
            );

          return { cancelled: true, missionId };
        },
      },
    },
  });

  return result.toUIMessageStreamResponse();
}

async function getDefaultRepo(userId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ repo: githubInstallationRepos.repo })
      .from(githubInstallationRepos)
      .innerJoin(
        githubInstallations,
        eq(githubInstallationRepos.installationId, githubInstallations.id),
      )
      .where(eq(githubInstallations.userId, userId))
      .limit(1);
    return row?.repo ?? 'paulmeller/forge';
  } catch {
    return 'paulmeller/forge';
  }
}
