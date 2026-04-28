import { desc, eq, and } from 'drizzle-orm';

import { memories, type Memory, type MemoryScope } from '@forge/db';

import { db } from './db';

export async function listMemories(
  scope?: MemoryScope,
  scopeKey?: string,
): Promise<Memory[]> {
  if (scope && scopeKey) {
    return db
      .select()
      .from(memories)
      .where(and(eq(memories.scope, scope), eq(memories.scopeKey, scopeKey)))
      .orderBy(desc(memories.confidence));
  }
  return db.select().from(memories).orderBy(desc(memories.confidence));
}

export async function getMemory(id: string): Promise<Memory | null> {
  const [row] = await db.select().from(memories).where(eq(memories.id, id)).limit(1);
  return row ?? null;
}
