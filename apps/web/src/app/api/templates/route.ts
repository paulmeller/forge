import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { apiAuth } from '@/lib/api-auth';
import { createTemplate, createTemplateSchema, listTemplates } from '@/lib/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const [, errorResponse] = await apiAuth();
  if (errorResponse) return errorResponse;

  const templates = await listTemplates();
  return NextResponse.json({ templates });
}

export async function POST(request: Request) {
  const [, errorResponse] = await apiAuth();
  if (errorResponse) return errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  try {
    const input = createTemplateSchema.parse(body);
    const template = await createTemplate(input);
    return NextResponse.json({ template }, { status: 201 });
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
