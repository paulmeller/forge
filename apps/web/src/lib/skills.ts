import { eq } from 'drizzle-orm';

import { skills, type Skill } from '@forge/db';

import { db } from './db';

export async function listSkills(): Promise<Skill[]> {
  return db.select().from(skills);
}

export async function getSkill(skillId: string): Promise<Skill | null> {
  const [row] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
  return row ?? null;
}
