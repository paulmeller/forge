import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { db } from '@/lib/db';
import { missions } from '@forge/db';

export const runtime = 'nodejs';

const HMAC_HEADER = 'x-forge-signature';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ missionId: string }> },
) {
  const { missionId } = await params;
  const rawBody = await request.text();

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, webhookSecret: true },
  });

  if (!mission) {
    return NextResponse.json({ error: 'mission not found' }, { status: 404 });
  }

  const signature = request.headers.get(HMAC_HEADER);
  if (!signature || !verifyHmac(mission.webhookSecret, rawBody, signature)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  // TODO(phase 1): parse event, append to ledger, update task state.
  // Keep this handler thin — heavy work runs in the next tick.

  return NextResponse.json({ received: true }, { status: 200 });
}

function verifyHmac(secret: string, body: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(signature, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
