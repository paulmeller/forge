import { NextResponse } from 'next/server';

import { apiAuth } from '@/lib/api-auth';
import { reviewProposal } from '@/lib/retrospectives';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ proposalId: string }> },
) {
  const [user, errorResponse] = await apiAuth();
  if (errorResponse) return errorResponse;

  const { proposalId } = await params;
  let body: { decision: string; editedContent?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const { decision, editedContent } = body;
  if (!['accepted', 'rejected', 'edited'].includes(decision)) {
    return NextResponse.json(
      { error: 'decision must be accepted, rejected, or edited' },
      { status: 400 },
    );
  }

  try {
    const proposal = await reviewProposal(
      proposalId,
      decision as 'accepted' | 'rejected' | 'edited',
      user.id,
      editedContent,
    );
    return NextResponse.json({ proposal });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'unknown error' },
      { status: 404 },
    );
  }
}
