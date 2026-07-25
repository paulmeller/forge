import { desc, sql } from '@forge/db/orm';
import { missions, type MissionStatus } from '@forge/db';

import { db } from './db';

export type RecentMission = { id: string; name: string; status: MissionStatus };

/** The user's most recent missions, newest first — used for the chat
 *  page's landing-state "Recent" list. */
export async function listRecentMissions(userId: string, limit: number): Promise<RecentMission[]> {
  const rows = await db
    .select({ id: missions.id, name: missions.name, status: missions.status })
    .from(missions)
    .where(sql`${missions.userId} = ${userId}`)
    .orderBy(desc(missions.createdAt))
    .limit(limit);

  return rows;
}
