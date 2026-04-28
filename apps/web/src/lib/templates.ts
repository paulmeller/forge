import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { backend, missionTemplates, type MissionTemplate, type NewMissionTemplate } from '@forge/db';

import { db } from './db';

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  goalTemplate: z.string().min(1).max(10_000),
  defaultBackend: z.enum(backend),
  defaultConcurrencyCap: z.coerce.number().int().min(1).max(100).default(5),
  defaultBudgetUsd: z.coerce.number().int().positive().nullish(),
  skillId: z.string().max(200).optional().nullable(),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export async function listTemplates(): Promise<MissionTemplate[]> {
  return db.select().from(missionTemplates);
}

export async function getTemplate(id: string): Promise<MissionTemplate | null> {
  const [row] = await db
    .select()
    .from(missionTemplates)
    .where(eq(missionTemplates.id, id))
    .limit(1);
  return row ?? null;
}

export async function createTemplate(input: CreateTemplateInput): Promise<MissionTemplate> {
  const now = new Date();
  const values: NewMissionTemplate = {
    id: `tmpl_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    name: input.name,
    description: input.description,
    goalTemplate: input.goalTemplate,
    defaultBackend: input.defaultBackend,
    defaultConcurrencyCap: input.defaultConcurrencyCap,
    defaultBudgetUsd: input.defaultBudgetUsd ?? null,
    skillId: input.skillId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const [created] = await db.insert(missionTemplates).values(values).returning();
  if (!created) throw new Error('template insert returned no rows');
  return created;
}

/** Seed built-in templates (idempotent). */
export const SEED_TEMPLATES: NewMissionTemplate[] = [
  {
    id: 'tmpl_dependency_bump',
    name: 'Dependency bump',
    description: 'Update a specific dependency to a target version across one or more repos.',
    goalTemplate: 'Update {{dep}} to {{version}} in {{repo}}',
    defaultBackend: 'managed-agents',
    defaultConcurrencyCap: 5,
    defaultBudgetUsd: null,
    skillId: null,
  },
  {
    id: 'tmpl_ci_fix',
    name: 'CI fix',
    description: 'Diagnose and fix CI failures on a repo.',
    goalTemplate: 'CI is failing on {{repo}}. Fix the errors and push.',
    defaultBackend: 'managed-agents',
    defaultConcurrencyCap: 3,
    defaultBudgetUsd: null,
    skillId: null,
  },
  {
    id: 'tmpl_add_endpoint',
    name: 'Add endpoint',
    description: 'Add a new API endpoint following existing patterns in a repo.',
    goalTemplate: 'Add a {{method}} {{path}} endpoint following existing patterns in {{repo}}',
    defaultBackend: 'managed-agents',
    defaultConcurrencyCap: 5,
    defaultBudgetUsd: null,
    skillId: null,
  },
];

export async function seedTemplates(): Promise<void> {
  for (const tmpl of SEED_TEMPLATES) {
    await db
      .insert(missionTemplates)
      .values({ ...tmpl, createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
  }
}
