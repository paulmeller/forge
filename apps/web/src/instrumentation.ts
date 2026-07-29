/**
 * Once-per-boot startup hook (replaces apps/tick/src/index.ts's startup sync —
 * consolidation spec §A). Non-fatal: a sync failure must not stop the server;
 * the dispatcher resolves built-in triage skills by slug from the synced table.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Schema preflight runs first, and its own failure is swallowed separately,
  // so a broken check can never be the reason the server does not boot.
  //
  // This exists because the device flow's first real call answered a bare 500:
  // the database was two migrations behind and `deviceCode` did not exist.
  // The whole unit suite passed, because every test builds its own schema —
  // nothing compared the code's expectations against the database it was
  // actually pointed at.
  try {
    const { db } = await import('@/lib/db');
    const { reportSchemaDrift } = await import('@/lib/schema-preflight');
    await reportSchemaDrift(db);
  } catch (err) {
    console.error('[instrumentation] schema preflight failed:', err);
  }

  try {
    const { syncSkillsToDb } = await import('@/server/tick/skill-loader');
    const { inserted, updated } = await syncSkillsToDb();
    console.log(`[instrumentation] skills synced (inserted=${inserted} updated=${updated})`);
  } catch (err) {
    console.error('[instrumentation] skill sync failed:', err);
  }
}
