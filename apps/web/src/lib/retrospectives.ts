import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { desc, eq } from 'drizzle-orm';

import {
  ledgerEvents,
  missions,
  retrospectives,
  retrospectiveProposals,
  type LedgerEvent,
  type Mission,
  type Retrospective,
  type RetrospectiveProposal,
} from '@forge/db';

import { db } from './db';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPT_PATH = resolve(__dirname, '../../../../prompts/retrospective.md');

export class RetrospectiveError extends Error {
  constructor(
    message: string,
    public readonly code: 'MISSION_NOT_FOUND' | 'MISSION_NOT_COMPLETED' | 'ALREADY_EXISTS',
  ) {
    super(message);
    this.name = 'RetrospectiveError';
  }
}

/**
 * Create a retrospective for a completed mission. Does NOT spawn the agent
 * session — that's handled by the tick service or an async job. This just
 * records the intent and prepares the input.
 */
export async function createRetrospective(
  missionId: string,
  requestedBy: string,
): Promise<{ retrospective: Retrospective; prompt: string }> {
  const [mission] = await db
    .select()
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);
  if (!mission) throw new RetrospectiveError('mission not found', 'MISSION_NOT_FOUND');
  if (mission.status !== 'completed' && mission.status !== 'cancelled') {
    throw new RetrospectiveError(
      `mission status is ${mission.status}; retrospective requires completed or cancelled`,
      'MISSION_NOT_COMPLETED',
    );
  }

  // Check for existing pending/running retrospective
  const [existing] = await db
    .select()
    .from(retrospectives)
    .where(eq(retrospectives.missionId, missionId))
    .limit(1);
  if (existing && (existing.status === 'pending' || existing.status === 'running')) {
    throw new RetrospectiveError(
      'a retrospective is already in progress for this mission',
      'ALREADY_EXISTS',
    );
  }

  const now = new Date();
  const id = `ret_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

  const [created] = await db
    .insert(retrospectives)
    .values({
      id,
      missionId,
      status: 'pending',
      requestedBy,
      createdAt: now,
    })
    .returning();
  if (!created) throw new Error('retrospective insert failed');

  const prompt = buildRetrospectivePrompt(mission, await getLedgerEvents(missionId));

  // Record in ledger
  await db.insert(ledgerEvents).values({
    id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    missionId,
    eventType: 'retrospective.requested',
    payload: { retrospectiveId: id, requestedBy },
    createdAt: now,
  });

  return { retrospective: created, prompt };
}

function buildRetrospectivePrompt(mission: Mission, events: LedgerEvent[]): string {
  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(PROMPT_PATH, 'utf-8');
  } catch {
    systemPrompt = '# Retrospective\nAnalyse the mission ledger and propose improvements.';
  }

  const missionSummary = JSON.stringify(
    {
      id: mission.id,
      name: mission.name,
      goal: mission.goal,
      status: mission.status,
      backend: mission.backend,
      startedAt: mission.startedAt,
      completedAt: mission.completedAt,
    },
    null,
    2,
  );

  const ledgerSummary = events.map((e) => ({
    id: e.id,
    taskId: e.taskId,
    type: e.eventType,
    payload: e.payload,
    at: e.createdAt,
  }));

  return `${systemPrompt}\n\n---\n\n## Mission\n\n\`\`\`json\n${missionSummary}\n\`\`\`\n\n## Ledger (${events.length} events)\n\n\`\`\`json\n${JSON.stringify(ledgerSummary, null, 2)}\n\`\`\``;
}

async function getLedgerEvents(missionId: string): Promise<LedgerEvent[]> {
  return db
    .select()
    .from(ledgerEvents)
    .where(eq(ledgerEvents.missionId, missionId))
    .orderBy(ledgerEvents.createdAt);
}

export async function getRetrospective(id: string): Promise<Retrospective | null> {
  const [row] = await db.select().from(retrospectives).where(eq(retrospectives.id, id)).limit(1);
  return row ?? null;
}

export async function getRetrospectiveForMission(missionId: string): Promise<Retrospective | null> {
  const [row] = await db
    .select()
    .from(retrospectives)
    .where(eq(retrospectives.missionId, missionId))
    .orderBy(desc(retrospectives.createdAt))
    .limit(1);
  return row ?? null;
}

export async function listProposals(retrospectiveId: string): Promise<RetrospectiveProposal[]> {
  return db
    .select()
    .from(retrospectiveProposals)
    .where(eq(retrospectiveProposals.retrospectiveId, retrospectiveId));
}

export async function reviewProposal(
  proposalId: string,
  decision: 'accepted' | 'rejected' | 'edited',
  reviewedBy: string,
  editedContent?: Record<string, unknown>,
): Promise<RetrospectiveProposal> {
  const now = new Date();
  const patch: Record<string, unknown> = {
    status: decision,
    reviewedBy,
    reviewedAt: now,
  };
  if (editedContent) {
    patch.content = editedContent;
  }

  const [updated] = await db
    .update(retrospectiveProposals)
    .set(patch)
    .where(eq(retrospectiveProposals.id, proposalId))
    .returning();
  if (!updated) throw new Error('proposal not found');

  // Record in ledger
  const retro = await getRetrospective(updated.retrospectiveId);
  if (retro) {
    await db.insert(ledgerEvents).values({
      id: `lev_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      missionId: retro.missionId,
      eventType: `retrospective.proposal_${decision}`,
      payload: { proposalId, reviewedBy, type: updated.type },
      createdAt: now,
    });
  }

  return updated;
}
