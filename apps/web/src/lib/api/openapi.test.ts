import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { responseSchemas } from './components';
import { missionResponseFields, taskResponseFields } from './dto';
import { apiErrorCodes } from './errors';
import { buildOpenApiDocument } from './openapi';
import { schemas } from './schemas';

// apps/web/src/lib/api → repo root is five levels up. Count carefully: this
// kind of relative chain broke twice on this project when files moved.
const SPEC_PATH = resolve(__dirname, '../../../../../docs/api/openapi.json');

// apps/web/src/lib/api → apps/web/src/app/(app) is where every /api/v1
// route file lives, one directory per URL segment. Used below to prove
// every documented operation actually has a route file behind it.
const ROUTES_ROOT = resolve(__dirname, '../../app/(app)');

type OpenApiDoc = {
  paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
};

/** `/api/v1/missions/{missionId}` -> the route.ts file that must implement it. */
function routeFileFor(urlPath: string): string {
  const dirPath = urlPath.replace(/\{([^}]+)\}/g, '[$1]');
  return resolve(ROUTES_ROOT, `.${dirPath}`, 'route.ts');
}

describe('openapi spec', () => {
  it('matches the committed document', () => {
    const generated = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
    if (process.env.UPDATE_OPENAPI) {
      writeFileSync(SPEC_PATH, generated);
      return;
    }
    // Fails the build when a schema changed and the spec was not regenerated.
    // Run `pnpm api:spec` to update it.
    expect(generated).toBe(readFileSync(SPEC_PATH, 'utf8'));
  });

  // Structural validity: a document that merely parses as JSON is not the
  // same as a document a real OpenAPI tool can load. This is what stops the
  // spec drifting from reality again — see Finding 8 of the Task 5 review.
  it('is structurally valid: every path is a URL template, every operation declares a response', () => {
    const doc = buildOpenApiDocument() as OpenApiDoc;
    const pathEntries = Object.entries(doc.paths);

    // Not vacuously true: there must be at least the mission/task routes
    // Tasks 1-5 actually shipped.
    expect(pathEntries.length).toBeGreaterThan(0);

    for (const [urlPath, operations] of pathEntries) {
      expect(urlPath.startsWith('/'), `paths key "${urlPath}" is not a URL path`).toBe(true);
      expect(Object.keys(operations).length).toBeGreaterThan(0);

      for (const [method, operation] of Object.entries(operations)) {
        expect(
          operation.responses && Object.keys(operation.responses).length > 0,
          `${method.toUpperCase()} ${urlPath} declares no responses`,
        ).toBe(true);
      }
    }
  });

  // The other half of Finding 8: a spec must describe what exists. Every
  // declared path+method has to correspond to a route file on disk that
  // actually exports that HTTP method — otherwise the spec is advertising
  // an operation nothing serves.
  it('every declared operation corresponds to a route file that exists on disk', () => {
    const doc = buildOpenApiDocument() as OpenApiDoc;

    for (const [urlPath, operations] of Object.entries(doc.paths)) {
      const filePath = routeFileFor(urlPath);
      expect(existsSync(filePath), `${urlPath} -> ${filePath} does not exist`).toBe(true);
      const source = readFileSync(filePath, 'utf8');

      for (const method of Object.keys(operations)) {
        const exportName = method.toUpperCase();
        expect(
          source.includes(`export const ${exportName}`),
          `${filePath} does not export ${exportName}`,
        ).toBe(true);
      }
    }
  });

  // Task 7: repos.* shipped its routes, so it's no longer in the "not yet"
  // bucket either — see the dedicated assertion below for what it now
  // advertises.
  it('advertises all three repo endpoints', () => {
    const doc = buildOpenApiDocument() as OpenApiDoc;
    expect(doc.paths['/api/v1/repos']?.get).toBeDefined();
    expect(doc.paths['/api/v1/repos/{owner}/{repo}/policy']?.get).toBeDefined();
    expect(doc.paths['/api/v1/repos/{owner}/{repo}/policy']?.put).toBeDefined();
  });

  // Task 6: the audit trail is the highest-value part of this API. Pin the
  // exact paths so a future refactor that silently drops one is caught here,
  // not just by the generic "every path resolves to a route" check above.
  it('advertises both ledger read endpoints', () => {
    const doc = buildOpenApiDocument() as OpenApiDoc;
    expect(doc.paths['/api/v1/missions/{missionId}/ledger']?.get).toBeDefined();
    expect(doc.paths['/api/v1/missions/{missionId}/tasks/{taskId}/ledger']?.get).toBeDefined();
  });

  // The spec had NO securitySchemes and no security block at all — the
  // bearer / x-api-key credential that is the entire point of this surface
  // was undocumented, so a generated client came out anonymous.
  it('documents both accepted credentials and applies them to the whole document', () => {
    const doc = buildOpenApiDocument() as {
      security: Record<string, string[]>[];
      components: { securitySchemes: Record<string, Record<string, unknown>> };
    };

    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(doc.components.securitySchemes.apiKeyAuth).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'x-api-key',
    });
    // Two entries, not one entry with two keys: alternatives, not a
    // requirement to present both.
    expect(doc.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
  });

  // Every operation used to declare `{"200": {description: "Success"}}` with
  // no schema, so a client generator learned nothing about the response. The
  // registry and the response map are keyed alike, and this is what stops a
  // new endpoint shipping with its request documented and its response not.
  it('gives every operation a success schema, a 401 and a default error', () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { content?: Record<string, { schema?: unknown }> }> }>
      >;
    };

    for (const [urlPath, operations] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const where = `${method.toUpperCase()} ${urlPath}`;
        const success = operation.responses['200'] ?? operation.responses['201'];
        expect(success, `${where} declares no 2xx response`).toBeDefined();
        expect(
          success!.content?.['application/json']?.schema,
          `${where} declares a 2xx with no schema`,
        ).toBeDefined();
        expect(operation.responses['401'], `${where} declares no 401`).toBeDefined();
        expect(operation.responses.default, `${where} declares no default error`).toBeDefined();
      }
    }
  });

  // The Mission schema must describe what the route actually returns, which
  // is lib/api/dto.ts's allow-list — not the missions table. If these two
  // ever diverge the spec is lying about a response body, so the check is
  // exact in both directions (a documented webhookSecret would fail here as
  // surely as an undocumented new field).
  it('documents exactly the mission and task fields the DTOs publish', () => {
    const doc = buildOpenApiDocument() as {
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };

    expect(Object.keys(doc.components.schemas.Mission!.properties).sort()).toEqual(
      [...missionResponseFields].sort(),
    );
    expect(Object.keys(doc.components.schemas.Mission!.properties)).not.toContain('webhookSecret');
    expect(Object.keys(doc.components.schemas.Task!.properties).sort()).toEqual(
      [...taskResponseFields].sort(),
    );
  });

  // The other direction of the same guard, checked against the registry
  // rather than the built document: a route-bearing operation with no
  // response schema would emit `schema: undefined` and silently produce a
  // schema-less 200 again.
  it('declares a response schema for every route-bearing registry operation', () => {
    const routed = Object.entries(schemas)
      .filter(([, def]) => 'path' in def && 'method' in def)
      .map(([operationId]) => operationId)
      .sort();
    expect(Object.keys(responseSchemas).sort()).toEqual(routed);
  });

  // Every $ref the document emits must resolve, or a generator fails to load
  // it. Cheap to check, and the kind of thing a hand-written components map
  // gets wrong exactly once.
  it('resolves every internal $ref', () => {
    const doc = buildOpenApiDocument();
    const declared = new Set(
      Object.keys((doc as { components: { schemas: Record<string, unknown> } }).components.schemas),
    );
    const refs = [...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const name of refs) {
      expect(declared.has(name), `$ref to undeclared schema "${name}"`).toBe(true);
    }
  });

  // The Error schema used to declare `code: { type: 'string' }`, which told a
  // CLI author nothing — and was true of three different vocabularies at
  // once. Enumerating the closed set is what makes it discoverable without
  // reading route handlers, so the enum must stay tied to apiErrorCodes.
  it('enumerates the closed error-code set in components.schemas.Error', () => {
    const doc = buildOpenApiDocument() as {
      components: {
        schemas: {
          Error: { properties: { error: { properties: { code: { enum?: string[] } } } } };
        };
      };
    };
    const codeSchema = doc.components.schemas.Error.properties.error.properties.code;
    expect(codeSchema.enum).toEqual([...apiErrorCodes]);
  });

  // Task 7 fix: toParameters (the parameter-lifting helper) used to mark a
  // query parameter `required: true` whenever the Zod schema's own JSON
  // Schema output listed it in `required` — but z.toJSONSchema lists a field
  // with `.default(...)` there too, even though the caller may omit it. That
  // told a CLI author `limit` was mandatory when it is not. Path params stay
  // `required: true` unconditionally (the only legal value OpenAPI allows
  // for `in: 'path'`) — this pins both directions so a fix that flips path
  // params to `false` too would also be caught.
  it('marks a defaulted query parameter required: false, and a path parameter required: true', () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { parameters?: { name: string; in: string; required: boolean }[] }>
      >;
    };
    const op = doc.paths['/api/v1/missions/{missionId}/ledger']?.get;
    const limitParam = op?.parameters?.find((p) => p.name === 'limit');
    const missionIdParam = op?.parameters?.find((p) => p.name === 'missionId');

    expect(limitParam?.in).toBe('query');
    expect(limitParam?.required).toBe(false);
    expect(missionIdParam?.in).toBe('path');
    expect(missionIdParam?.required).toBe(true);
  });
});
