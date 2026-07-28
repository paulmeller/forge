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
  return { openapi: '3.1.0', info: { title: 'Forge API', version: '1.0.0' }, paths };
}
