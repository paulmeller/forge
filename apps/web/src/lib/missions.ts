import { randomBytes, randomUUID } from 'node:crypto';

import { and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { z } from 'zod';

import { backend, missionStatus, missions, plannerStrategy, type Mission, type NewMission } from '@forge/db';

import { db } from './db';
import { userCanAccessRepo } from './mission-defaults-db';
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
  issueQuery: z.string().max(500).optional().nullable(),
  concurrencyCap: z.coerce.number().int().min(1).max(100).default(5),
  budgetUsd: z.coerce.number().int().positive().nullish(),
  budgetTokens: z.coerce.number().int().positive().nullish(),
  budgetThresholdPct: z.coerce.number().int().min(1).max(100).default(80),
  budgetHardStopPct: z.coerce.number().int().min(1).max(500).default(100),
  taskMaxTurns: z.coerce.number().int().positive().nullish(),
  taskMaxTokens: z.coerce.number().int().positive().nullish(),
  noProgressTokens: z.coerce.number().int().positive().nullish(),
  githubInstallationId: z.string().max(200).optional().nullable(),
  githubVaultId: z.string().max(200).optional().nullable(),
  skillId: z.string().max(200).optional().nullable(),
  aiReviewEnabled: z.coerce.boolean().default(false),
  selfVerifyEnabled: z.coerce.boolean().default(false),
}).superRefine((val, ctx) => {
  // The triage Planner enumerates issues from issueQuery instead of repos.
  if (val.plannerStrategy === 'triage' && !val.issueQuery?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['issueQuery'],
      message: 'Triage missions need a GitHub issue search query.',
    });
  }
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
 * Thrown by createMissionForUser when the caller asked to target one or more
 * repos their GitHub App installation does not cover. Deliberately not a
 * ZodError — this is an authorization failure discovered after schema
 * validation, not a shape problem with the request — so route handlers can
 * distinguish "bad input" (400) from "not allowed" (403) and the Server
 * Action path (which already treats any non-ZodError Error as a surfaceable
 * message) needs no special casing to show it.
 */
export class RepoAccessError extends Error {
  constructor(public readonly repos: string[]) {
    super(
      repos.length === 1
        ? `No access to repo "${repos[0]}"`
        : `No access to repos: ${repos.join(', ')}`,
    );
    this.name = 'RepoAccessError';
  }
}

/**
 * Create a mission for a specific user. Use createMissionAuthed() from
 * server components (auto-reads the session).
 *
 * Every targetRepo must pass userCanAccessRepo before anything is written.
 * This is the one place the web UI's Server Action and POST /api/v1/missions
 * both funnel through, so gating only the route would leave the Server
 * Action path (and any other future caller of createMissionForUser) open.
 *
 * The whole call is rejected if ANY repo fails the check — never silently
 * filtered — because a caller who asked for three repos and got a mission
 * scoped to one has been told something false about what was created.
 *
 * If the access lookup itself throws, that error propagates as-is (fails
 * closed): it is not caught and reinterpreted as either "granted" or
 * "denied", and — because it's awaited before the insert below — no mission
 * row can be written while the caller's access is unproven.
 */
export async function createMissionForUser(
  userId: string,
  input: CreateMissionInput,
): Promise<Mission> {
  if (input.targetRepos.length > 0) {
    const results = await Promise.all(
      input.targetRepos.map(async (repo) => ({ repo, allowed: await userCanAccessRepo(userId, repo) })),
    );
    const denied = results.filter((r) => !r.allowed).map((r) => r.repo);
    if (denied.length > 0) {
      throw new RepoAccessError(denied);
    }
  }

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
    issueQuery: input.issueQuery ?? null,
    concurrencyCap: input.concurrencyCap,
    budgetUsd: input.budgetUsd ?? null,
    budgetTokens: input.budgetTokens ?? null,
    budgetThresholdPct: input.budgetThresholdPct,
    budgetHardStopPct: input.budgetHardStopPct,
    taskMaxTurns: input.taskMaxTurns ?? null,
    taskMaxTokens: input.taskMaxTokens ?? null,
    noProgressTokens: input.noProgressTokens ?? null,
    webhookSecret: randomBytes(32).toString('hex'),
    githubInstallationId: input.githubInstallationId ?? null,
    githubVaultId: input.githubVaultId ?? null,
    skillId: input.skillId ?? null,
    aiReviewEnabled: input.aiReviewEnabled ?? false,
    selfVerifyEnabled: input.selfVerifyEnabled ?? false,
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

/**
 * List missions for a specific user — every campaign and issue leaf, but
 * never a repo's container (workspaceRepo set, issueRef null, no
 * parentMissionId — a pure budget/concurrency envelope, never a unit of
 * work). Expressed as "NOT a container": either it isn't repo-scoped at
 * all (campaign), or it's specifically issue-scoped (issueRef set), or it
 * has a parent itself (defensive — containers are always roots).
 *
 * `status`, when given, narrows to that lifecycle status only — this is
 * what GET /api/v1/missions's `?status=` query filter (declared in
 * lib/api/schemas.ts's `missions.list` entry) actually runs against.
 */
export async function listMissionsForUser(userId: string, status?: string): Promise<Mission[]> {
  return db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.userId, userId),
        status ? eq(missions.status, status as (typeof missionStatus)[number]) : undefined,
        or(
          isNull(missions.workspaceRepo),
          isNotNull(missions.issueRef),
          isNotNull(missions.parentMissionId),
        ),
      ),
    )
    .orderBy(desc(missions.createdAt));
}

/** Server-component convenience: reads auth session, lists missions. */
export async function listMissions(): Promise<Mission[]> {
  const user = await withAuth();
  return listMissionsForUser(user.id);
}

/**
 * Ownership-scoped lookup — userId is required (not optional/defaulted) so
 * the compiler forces every call site to supply the caller's identity. A
 * mission that exists but belongs to someone else returns null, identical
 * to a nonexistent id, so existence isn't observable across accounts.
 */
export async function getMission(id: string, userId: string): Promise<Mission | null> {
  const [row] = await db
    .select()
    .from(missions)
    .where(and(eq(missions.id, id), eq(missions.userId, userId)))
    .limit(1);
  return row ?? null;
}
