import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi';

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

  // repos.* and ledger.* are registered in schemas.ts for future use but
  // have no routes yet (Tasks 6-7). They must not appear in the spec.
  it('does not advertise operations with no route yet', () => {
    const doc = buildOpenApiDocument() as OpenApiDoc;
    const urlPaths = Object.keys(doc.paths);
    expect(urlPaths.some((p) => p.includes('repos'))).toBe(false);
    expect(urlPaths.some((p) => p.includes('ledger'))).toBe(false);
  });
});
