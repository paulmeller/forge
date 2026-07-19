/**
 * Once-per-boot startup hook (replaces apps/tick/src/index.ts's startup sync —
 * consolidation spec §A). Non-fatal: a sync failure must not stop the server;
 * the dispatcher resolves built-in triage skills by slug from the synced table.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { syncSkillsToDb } = await import('@/server/tick/skill-loader');
    const { inserted, updated } = await syncSkillsToDb();
    console.log(`[instrumentation] skills synced (inserted=${inserted} updated=${updated})`);
  } catch (err) {
    console.error('[instrumentation] skill sync failed:', err);
  }
}
