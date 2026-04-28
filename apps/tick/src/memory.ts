import { randomUUID } from 'node:crypto';

import { and, eq, inArray, lte, sql } from 'drizzle-orm';

import { ledgerEvents, memories, type Memory, type NewMemory } from '@forge/db';

import { db } from './db';

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
};

export type MemoryResult = {
  expired: number;
  reconfirmationNeeded: number;
};

/**
 * Retrieve relevant memories for a task dispatch context.
 *
 * Filters by repo (scope=repo), backend (scope=backend), and global scope.
 * Returns memories sorted by confidence descending.
 */
export async function getRelevantMemories(opts: {
  repo: string;
  backend: string;
}): Promise<Memory[]> {
  const rows = await db
    .select()
    .from(memories)
    .where(
      sql`(
        (${memories.scope} = 'global') OR
        (${memories.scope} = 'repo' AND ${memories.scopeKey} = ${opts.repo}) OR
        (${memories.scope} = 'backend' AND ${memories.scopeKey} = ${opts.backend})
      )`,
    )
    .orderBy(sql`${memories.confidence} DESC`);

  // Filter out expired memories
  const now = Date.now();
  return rows.filter((m) => !m.expiresAt || m.expiresAt.getTime() > now);
}

/**
 * Format memories as text to inject into an agent session prompt.
 */
export function formatMemoriesForPrompt(mems: Memory[]): string {
  if (mems.length === 0) return '';

  const lines = mems.map((m) => {
    const conf = Math.round(m.confidence);
    return `- [${m.scope}/${m.scopeKey}] ${m.key}: ${m.value} (confidence: ${conf}%)`;
  });

  return `## Forge Memories\n\nThe following facts were learned from previous Missions. Use them if relevant:\n\n${lines.join('\n')}\n`;
}

/**
 * Increment confidence for memories that were associated with a successful task.
 */
export async function boostConfidence(memoryIds: string[], delta = 5): Promise<void> {
  if (memoryIds.length === 0) return;
  await db
    .update(memories)
    .set({
      confidence: sql`min(100, ${memories.confidence} + ${delta})`,
      updatedAt: new Date(),
    })
    .where(inArray(memories.id, memoryIds));
}

/**
 * Decrement confidence for memories associated with a failed task.
 */
export async function decayConfidence(memoryIds: string[], delta = 10): Promise<void> {
  if (memoryIds.length === 0) return;
  await db
    .update(memories)
    .set({
      confidence: sql`max(0, ${memories.confidence} - ${delta})`,
      updatedAt: new Date(),
    })
    .where(inArray(memories.id, memoryIds));
}

/**
 * Create a memory from a retrospective proposal.
 */
export async function createMemoryFromProposal(opts: {
  scope: 'repo' | 'backend' | 'global';
  scopeKey: string;
  key: string;
  value: string;
  confidence: number;
  sourceId: string;
}): Promise<Memory> {
  const now = new Date();
  // Default expiry: 90 days
  const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const values: NewMemory = {
    id: `mem_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    scope: opts.scope,
    scopeKey: opts.scopeKey,
    key: opts.key,
    value: opts.value,
    confidence: Math.round(opts.confidence * 100), // 0.0-1.0 → 0-100
    sourceType: 'retrospective',
    sourceId: opts.sourceId,
    learnedAt: now,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };

  const [created] = await db.insert(memories).values(values).returning();
  if (!created) throw new Error('memory insert failed');
  return created;
}

/**
 * Per-tick expiry check. Removes expired memories and flags low-confidence
 * ones for reconfirmation via the retrospective process.
 */
export async function runMemoryExpiry(log: Logger): Promise<MemoryResult> {
  const now = new Date();

  // Delete expired memories
  const expired = await db
    .delete(memories)
    .where(and(lte(memories.expiresAt, now)))
    .returning({ id: memories.id });

  for (const m of expired) {
    log.info({ memoryId: m.id }, 'memory:expired');
  }

  // Flag low-confidence memories (below 20%) for reconfirmation
  const lowConfidence = await db
    .select()
    .from(memories)
    .where(lte(memories.confidence, 20));

  if (lowConfidence.length > 0) {
    log.info(
      { count: lowConfidence.length },
      'memory:low_confidence_flagged',
    );
  }

  return {
    expired: expired.length,
    reconfirmationNeeded: lowConfidence.length,
  };
}

/**
 * List all memories, optionally filtered by scope.
 */
export async function listMemories(scope?: string, scopeKey?: string): Promise<Memory[]> {
  if (scope && scopeKey) {
    return db
      .select()
      .from(memories)
      .where(and(eq(memories.scope, scope as 'repo' | 'backend' | 'global'), eq(memories.scopeKey, scopeKey)));
  }
  return db.select().from(memories);
}
