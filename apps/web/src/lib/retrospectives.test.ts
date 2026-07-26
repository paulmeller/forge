import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-retrospectives-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let reviewProposal: typeof import('./retrospectives').reviewProposal;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ reviewProposal } = await import('./retrospectives'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

/** Inserts a mission → retrospective → proposal chain owned by `ownerId`. */
async function insertProposalChain(ownerId: string) {
  const now = new Date();
  const missionId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const retroId = `ret_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const proposalId = `prp_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  await db.insert(schema.missions).values({
    id: missionId,
    userId: ownerId,
    name: 'Test mission',
    goal: 'test',
    status: 'completed',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.retrospectives).values({
    id: retroId,
    missionId,
    status: 'completed',
    requestedBy: ownerId,
    createdAt: now,
  });
  await db.insert(schema.retrospectiveProposals).values({
    id: proposalId,
    retrospectiveId: retroId,
    type: 'memory_entry',
    status: 'pending',
    content: {
      scope: 'repo',
      scopeKey: 'acme/widgets',
      key: 'secret',
      value: "another user's proposal payload",
      confidence: 0.9,
      rationale: 'test fixture',
    },
    createdAt: now,
  });

  return { missionId, retroId, proposalId };
}

async function proposalStatus(proposalId: string) {
  const [row] = await db
    .select()
    .from(schema.retrospectiveProposals)
    .where(eq(schema.retrospectiveProposals.id, proposalId));
  return row;
}

describe('reviewProposal', () => {
  it('accepts a proposal for the mission owner', async () => {
    const { proposalId } = await insertProposalChain('owner_1');

    const updated = await reviewProposal(proposalId, 'owner_1', 'accepted');
    expect(updated.status).toBe('accepted');
    expect(updated.reviewedBy).toBe('owner_1');

    const row = await proposalStatus(proposalId);
    expect(row?.status).toBe('accepted');
  });

  it('rejects a review from a non-owner and leaves the proposal untouched (IDOR guard)', async () => {
    const { proposalId } = await insertProposalChain('owner_2');

    await expect(reviewProposal(proposalId, 'attacker_1', 'accepted')).rejects.toThrow(
      'proposal not found',
    );

    const row = await proposalStatus(proposalId);
    expect(row?.status).toBe('pending');
    expect(row?.reviewedBy).toBeNull();
  });

  it('rejects a nonexistent proposal id identically to a non-owned one', async () => {
    await expect(reviewProposal('prp_does_not_exist', 'owner_1', 'accepted')).rejects.toThrow(
      'proposal not found',
    );
  });

  it('applies editedContent only for the owner', async () => {
    const { proposalId } = await insertProposalChain('owner_3');

    const updated = await reviewProposal(proposalId, 'owner_3', 'edited', { note: 'revised' });
    expect(updated.content).toEqual({ note: 'revised' });
  });
});
