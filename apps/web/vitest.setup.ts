// Stub the env vars our modules need at load time. These values are never
// reached because tests don't actually open DB connections — they exercise
// pure functions and module exports. Setting them here keeps src/lib/db.ts
// from throwing during import.
process.env.DATABASE_URL ||= 'file:./test-noop.db';
process.env.BETTER_AUTH_SECRET ||= 'test-secret-not-used-in-unit-tests';
process.env.FORGE_BACKEND ||= 'managed-agents';
