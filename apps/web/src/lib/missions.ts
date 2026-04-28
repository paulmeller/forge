import { randomBytes, randomUUID } from 'node:crypto';

import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { backend, missions, plannerStrategy, type Mission, type NewMission } from '@forge/db';

import { db } from './db';
import { withAuth } from './with-auth';

const repoSlugPattern = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

export const createMissionSchema = z.object({
  name: z.string().min(1).max(200),
  goal: z.string().min(1).max(10_000),
  backend: z.enum(backend),
  agentId: z.string().min(1).max(200),
  plannerStrategy: z.enum(plannerStrategy).default('rule-based'),
  targetRepos: z
    .array(z.string().regex(repoSlugPattern, 'Expected "owner/repo"'))
    .max(500)
    .default([]),
  concurrencyCap: z.coerce.number().int().min(1).max(100).default(5),
  budgetUsd: z.coerce.number().int().positive().nullish(),
  budgetTokens: z.coerce.number().int().positive().nullish(),
  budgetThresholdPct: z.coerce.number().int().min(1).max(100).default(80),
  githubInstallationId: z.string().max(200).optional().nullable(),
  githubVaultId: z.string().max(200).optional().nullable(),
  skillId: z.string().max(200).optional().nullable(),
  aiReviewEnabled: z.coerce.boolean().default(false),
});

export function parseRepoList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
}

export type CreateMissionInput = z.infer<typeof createMissionSchema>;

/**
 * Create a mission for a specific user. Use createMissionAuthed() from
 * server components (auto-reads the session).
 */
export async function createMissionForUser(
  userId: string,
  input: CreateMissionInput,
): Promise<Mission> {
  const now = new Date();
  const values: NewMission = {
    id: `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    userId,
    name: input.name,
    goal: input.goal,
    status: 'draft',
    backend: input.backend,
    agentId: input.agentId,
    plannerStrategy: input.plannerStrategy,
    targetRepos: input.targetRepos,
    concurrencyCap: input.concurrencyCap,
    budgetUsd: input.budgetUsd ?? null,
    budgetTokens: input.budgetTokens ?? null,
    budgetThresholdPct: input.budgetThresholdPct,
    webhookSecret: randomBytes(32).toString('hex'),
    githubInstallationId: input.githubInstallationId ?? null,
    githubVaultId: input.githubVaultId ?? null,
    skillId: input.skillId ?? null,
    aiReviewEnabled: input.aiReviewEnabled ?? false,
    createdAt: now,
    updatedAt: now,
  };

  const [created] = await db.insert(missions).values(values).returning();
  if (!created) throw new Error('mission insert returned no rows');
  return created;
}

/** Server-component convenience: reads auth session, creates mission. */
export async function createMission(input: CreateMissionInput): Promise<Mission> {
  const user = await withAuth();
  return createMissionForUser(user.id, input);
}

/** List missions for a specific user. */
export async function listMissionsForUser(userId: string): Promise<Mission[]> {
  return db
    .select()
    .from(missions)
    .where(eq(missions.userId, userId))
    .orderBy(desc(missions.createdAt));
}

/** Server-component convenience: reads auth session, lists missions. */
export async function listMissions(): Promise<Mission[]> {
  const user = await withAuth();
  return listMissionsForUser(user.id);
}

export async function getMission(id: string): Promise<Mission | null> {
  const [row] = await db
    .select()
    .from(missions)
    .where(eq(missions.id, id))
    .limit(1);
  return row ?? null;
}
