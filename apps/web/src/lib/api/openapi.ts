import { z } from 'zod';
import { schemas } from './schemas';

// Each registry entry declares a different subset of method/path/params/
// query/body (that specificity is what lets route handlers rely on exact
// keys), so the union Object.entries produces doesn't structurally expose
// all five. This shape is only for iterating the registry generically here;
// it doesn't change what schemas.ts exports. `method`/`path` are optional:
// repos.* and ledger.* carry neither (no route exists yet), and
// buildOpenApiDocument skips any entry missing either.
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type SchemaDef = {
  method?: HttpMethod;
  path?: string;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
};

type JsonSchemaObject = {
  properties?: Record<string, unknown>;
  required?: string[];
};

/**
 * Lifts each top-level property of an object Zod schema into its own
 * OpenAPI `parameters` entry. Path params are always `required: true` (the
 * only thing OpenAPI allows for `in: 'path'`); query params are required
 * only when the object schema itself lists them as required.
 */
function toParameters(
  schema: z.ZodTypeAny,
  location: 'path' | 'query',
  allRequired: boolean,
): Record<string, unknown>[] {
  const json = z.toJSONSchema(schema) as JsonSchemaObject;
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, propSchema]) => ({
    name,
    in: location,
    required: allRequired || required.has(name),
    schema: propSchema,
  }));
}

/**
 * Derives the OpenAPI document from the same Zod schemas the handlers
 * validate with, so the spec cannot drift from the implementation. Hand-
 * authoring it would make drift a matter of discipline; deriving it makes
 * drift structurally impossible.
 *
 * `paths` is keyed by real URL templates (`/api/v1/missions/{missionId}`),
 * each holding one entry per lower-cased HTTP method, per the OpenAPI 3.1
 * spec — not by operation id, which is not a legal `paths` key and which no
 * OpenAPI tool would ever look for there.
 */
export function buildOpenApiDocument(): unknown {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [operationId, def] of Object.entries(schemas) as [string, SchemaDef][]) {
    // No route exists for this operation yet (repos.*, ledger.* — Tasks 6-7
    // will add them). A spec must describe what exists, so operations
    // without a path/method are left out entirely rather than advertised.
    if (!def.path || !def.method) continue;

    const parameters: Record<string, unknown>[] = [
      ...(def.params ? toParameters(def.params, 'path', true) : []),
      ...(def.query ? toParameters(def.query, 'query', false) : []),
    ];

    const successStatus = def.method === 'POST' && operationId === 'missions.create' ? '201' : '200';

    const operation: Record<string, unknown> = {
      operationId,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(def.body
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: z.toJSONSchema(def.body) },
              },
            },
          }
        : {}),
      responses: {
        [successStatus]: { description: 'Success' },
        // One shared error response for every non-2xx outcome, reusing
        // components.schemas.Error rather than inlining the same shape at
        // every operation — see that schema's own doc comment for what it
        // covers and the trade-off it records.
        default: {
          description: 'Error',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Error' } },
          },
        },
      },
    };

    const method = def.method.toLowerCase();
    const pathItem = (paths[def.path] ??= {});
    pathItem[method] = operation;
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
