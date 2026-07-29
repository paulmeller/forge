import { sql } from 'drizzle-orm';

import * as schema from '@forge/db';

/** Minimal shape of a drizzle client — enough to run one raw query. */
type Queryable = { run: (query: ReturnType<typeof sql>) => Promise<unknown> } & {
  all: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

/**
 * Every table name the application code declares.
 *
 * Derived from the schema module rather than hand-listed, so a table added in
 * six months is covered without anyone remembering to add it here — the same
 * reasoning as the response-DTO allow-list.
 */
export function declaredTableNames(): string[] {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    // Drizzle stores the SQL name on a symbol-keyed property. Reading it via
    // the symbol description avoids importing drizzle's internals, which are
    // not part of its public API and have moved between minor versions.
    if (!value || typeof value !== 'object') continue;
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      if (symbol.description !== 'drizzle:Name') continue;
      const name = (value as Record<symbol, unknown>)[symbol];
      if (typeof name === 'string') names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Which of `expected` the database does not actually have.
 *
 * Comparison is case-sensitive on purpose: this schema has exactly one
 * camelCase table (`deviceCode`), and it is the one whose absence produced a
 * bare 500 from POST /api/auth/device/code with nothing to diagnose from.
 * SQLite would happily resolve `devicecode` for some statements and not
 * others, so treating them as the same name would reintroduce the ambiguity
 * this check exists to remove.
 */
export async function findMissingTables(
  db: unknown,
  expected: string[] = declaredTableNames(),
): Promise<string[]> {
  const rows = (await (db as Queryable).all(
    sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
  )) as { name: string }[];

  // sqlite_* names are the engine's own bookkeeping (sqlite_sequence appears
  // as soon as anything uses AUTOINCREMENT). They are never declared by us,
  // and we only ever report tables that are MISSING, so they cannot leak into
  // the result — filtered for clarity rather than correctness.
  const present = new Set(rows.map((r) => r.name).filter((n) => !n.startsWith('sqlite_')));
  return expected.filter((name) => !present.has(name));
}

/**
 * Reports a schema that is behind the code, loudly enough to act on.
 *
 * Deliberately NOT fatal. On Cloud Run a crash-looping revision takes the
 * whole service down, including the endpoints whose tables are present — a
 * total outage in place of a partial one. The failure this guards against is
 * not "the server should refuse to run", it is "nobody could tell why a
 * request 500'd", so the fix is a message naming the missing tables and the
 * command that applies them.
 */
export async function reportSchemaDrift(db: unknown): Promise<string[]> {
  const missing = await findMissingTables(db);
  if (missing.length > 0) {
    console.error(
      `[preflight] database is behind the code — missing ${missing.length} table(s): ` +
        `${missing.join(', ')}. Every request touching them will fail. ` +
        `Apply migrations with: pnpm --filter @forge/db db:migrate`,
    );
  }
  return missing;
}
