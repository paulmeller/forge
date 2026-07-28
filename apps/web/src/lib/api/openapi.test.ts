import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi';

// apps/web/src/lib/api → repo root is five levels up. Count carefully: this
// kind of relative chain broke twice on this project when files moved.
const SPEC_PATH = resolve(__dirname, '../../../../../docs/api/openapi.json');

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
});
