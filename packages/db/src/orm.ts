// Re-export drizzle-orm helpers from @forge/db's own dependency instance.
// This avoids duplicate-package type mismatches when consumers also have
// drizzle-orm in their own node_modules (e.g. via @ai-sdk transitive deps).
export { and, desc, eq, inArray, sql } from 'drizzle-orm';
