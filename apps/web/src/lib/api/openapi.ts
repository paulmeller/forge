import { z } from 'zod';
import {
  componentSchemas,
  documentSecurity,
  responseSchemas,
  securitySchemes,
} from './components';
import { schemas } from './schemas';

// Each registry entry declares a different subset of method/path/params/
// query/body (that specificity is what lets route handlers rely on exact
// keys), so the union Object.entries produces doesn't structurally expose
// all five. This shape is only for iterating the registry generically here;
// it doesn't change what schemas.ts exports. `method`/`path` are optional so
// that an operation can be registered before its route exists, and
// buildOpenApiDocument skips any entry missing either — a spec must describe
// what exists. Every entry carries both today (repos.* and ledger.* were the
// last two without, and shipped their routes in Tasks 6-7), so nothing is
// currently skipped.
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type SchemaDef = {
  method?: HttpMethod;
  path?: string;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
};

type JsonSchemaProperty = { default?: unknown };

type JsonSchemaObject = {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

/**
 * Lifts each top-level property of an object Zod schema into its own
 * OpenAPI `parameters` entry. Path params are always `required: true` (the
 * only thing OpenAPI allows for `in: 'path'`); query params are required
 * only when the object schema itself lists them as required.
 *
 * `z.toJSONSchema` puts a field in `required` even when the Zod schema gave
 * it a `.default(...)` — the field can still be *omitted* by a caller, it
 * just won't come out `undefined`. Left unchecked, that told a CLI author
 * `limit` (schemas.ts's `ledger.mission`/`ledger.task` query, default 200)
 * was mandatory when it is not (Task 7 finding). A defaulted property is
 * therefore never required, regardless of what `required` says — checked
 * before consulting `required` at all, so it can't be overridden back to
 * `true` by that array.
 */
function toParameters(
  schema: z.ZodTypeAny,
  location: 'path' | 'query',
  allRequired: boolean,
): Record<string, unknown>[] {
  const json = z.toJSONSchema(schema) as JsonSchemaObject;
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, propSchema]) => {
    const hasDefault = propSchema !== null && typeof propSchema === 'object' && 'default' in propSchema;
    return {
      name,
      in: location,
      required: !hasDefault && (allRequired || required.has(name)),
      schema: propSchema,
    };
  });
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
    // A spec must describe what exists: an operation registered without a
    // path/method has no route behind it, so it is left out entirely rather
    // than advertised. No entry is in that state today.
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
        [successStatus]: {
          description: 'Success',
          // Every operation used to declare `{description: "Success"}` and
          // nothing else, so a generated client knew how to CALL the API and
          // nothing about what came back. responseSchemas (lib/api/
          // components.ts) is keyed by the same operation ids as the request
          // registry, and openapi.test.ts asserts the two key sets match, so
          // a new endpoint cannot ship documenting only its request.
          content: { 'application/json': { schema: responseSchemas[operationId] } },
        },
        // Called out separately from `default` because it is the one failure
        // every caller hits first and must handle before any other: it is
        // the answer to a missing, malformed or expired credential, and it
        // is what tells a CLI to re-authenticate rather than retry.
        '401': {
          description: 'Authentication required — no usable bearer token or x-api-key',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Error' } },
          },
        },
        // One shared error response for every other non-2xx outcome, reusing
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
    // Applied at the document level rather than per operation: every /api/v1
    // route goes through withApiAuth (lib/api/auth.ts) with no exceptions, so
    // repeating `security` on each operation would be 18 copies of one fact
    // and 18 places for an exception to hide. The two entries are
    // alternatives (OpenAPI's OR) — either credential satisfies any call.
    security: documentSecurity,
    paths,
    components: {
      // Recorded per Task 4b Step 3: the pre-v1 POST /api/missions returned
      // { error: 'validation failed', issues: err.issues } — a full per-field
      // Zod issue array, so a caller could tell exactly which field failed.
      // Every v1 route instead uses one fixed envelope everywhere, joining
      // multi-issue Zod errors into a single message string. That is a
      // deliberate trade-off (one predictable shape for every route, at the
      // cost of per-field addressability for a CLI), not an oversight — see
      // componentSchemas.Error in lib/api/components.ts, where the shape and
      // this note now live together with the rest of the schemas.
      schemas: componentSchemas,
      securitySchemes,
    },
  };
}
