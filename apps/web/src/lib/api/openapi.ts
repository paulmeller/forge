import { z } from 'zod';
import { schemas } from './schemas';

// Each registry entry declares a different subset of params/query/body (that
// specificity is what lets route handlers rely on exact keys), so the union
// Object.entries produces doesn't structurally expose all three. This shape
// is only for iterating the registry generically here; it doesn't change
// what schemas.ts exports.
type SchemaDef = {
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
};

/**
 * Derives the OpenAPI document from the same Zod schemas the handlers
 * validate with, so the spec cannot drift from the implementation. Hand-
 * authoring it would make drift a matter of discipline; deriving it makes
 * drift structurally impossible.
 */
export function buildOpenApiDocument(): unknown {
  const paths: Record<string, unknown> = {};
  for (const [operationId, def] of Object.entries(schemas) as [string, SchemaDef][]) {
    paths[operationId] = {
      operationId,
      params: def.params ? z.toJSONSchema(def.params) : undefined,
      query: def.query ? z.toJSONSchema(def.query) : undefined,
      body: def.body ? z.toJSONSchema(def.body) : undefined,
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Forge API', version: '1.0.0' },
    paths,
    components: {
      schemas: {
        // Recorded per Task 4b Step 3: the pre-v1 POST /api/missions returned
        // { error: 'validation failed', issues: err.issues } — a full
        // per-field Zod issue array, so a caller could tell exactly which
        // field failed. Every v1 route instead uses this one fixed envelope
        // everywhere, joining multi-issue Zod errors into a single message
        // string. That is a deliberate trade-off (one predictable shape for
        // every route, at the cost of per-field addressability for a CLI),
        // not an oversight — recorded here so it's a decision on record.
        Error: {
          type: 'object',
          description:
            'Fixed error envelope used by every v1 route. Trade-off: collapses ' +
            'multi-field Zod validation failures into one joined message ' +
            'string, rather than the per-field issue array the deleted ' +
            'POST /api/missions used to return.',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['error'],
        },
      },
    },
  };
}
