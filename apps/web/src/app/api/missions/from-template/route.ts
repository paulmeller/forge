import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { z } from 'zod';

import { apiAuth } from '@/lib/api-auth';
import { createMissionForUser, createMissionSchema } from '@/lib/missions';
import { getTemplate } from '@/lib/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const fromTemplateSchema = z.object({
  templateId: z.string().min(1),
  /** Override fields — merged on top of template defaults. */
  overrides: createMissionSchema.partial().optional(),
});

export async function POST(request: Request) {
  const [user, errorResponse] = await apiAuth();
  if (errorResponse) return errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  try {
    const { templateId, overrides } = fromTemplateSchema.parse(body);
    const template = await getTemplate(templateId);
    if (!template) {
      return NextResponse.json({ error: 'template not found' }, { status: 404 });
    }

    const merged = createMissionSchema.parse({
      name: overrides?.name ?? template.name,
      goal: overrides?.goal ?? template.goalTemplate,
      backend: overrides?.backend ?? template.defaultBackend,
      agentId: overrides?.agentId ?? '',
      concurrencyCap: overrides?.concurrencyCap ?? template.defaultConcurrencyCap,
      budgetUsd: overrides?.budgetUsd ?? template.defaultBudgetUsd,
      skillId: overrides?.skillId ?? template.skillId,
      targetRepos: overrides?.targetRepos ?? [],
      plannerStrategy: overrides?.plannerStrategy ?? 'rule-based',
      budgetThresholdPct: overrides?.budgetThresholdPct ?? 80,
    });

    const mission = await createMissionForUser(user.id, merged);
    return NextResponse.json({ mission }, { status: 201 });
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: 'validation failed', issues: err.issues },
        { status: 400 },
      );
    }
    throw err;
  }
}
