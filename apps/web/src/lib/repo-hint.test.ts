import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_LOCATION_HINT } from './repo-hint';

const SRC = resolve(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('REPO_LOCATION_HINT', () => {
  it('does not assert a fixed absolute path', () => {
    // The hint is injected into prompts that run on both hosted Managed Agents
    // (repo under /mnt/session/resources/) and self-hosted sandboxes (repo is
    // the working directory). Asserting either one is wrong half the time.
    expect(REPO_LOCATION_HINT).not.toMatch(/\/mnt\/session/);
    expect(REPO_LOCATION_HINT).not.toMatch(/\/workspace\//);
  });

  it('tells the agent how to resolve the path itself', () => {
    expect(REPO_LOCATION_HINT).toContain('git rev-parse --show-toplevel');
  });

  // #65: three prompt sites each hardcoded `/mnt/session/resources/repo_0`, the
  // hosted-CMA layout. Against a self-hosted sandbox the first command an agent
  // ran failed and it burned turns running `find /` to locate the checkout.
  // Duplication is what let the wrong value persist in three places at once.
  it('is the only place a repo location is stated — no source file hardcodes one', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !f.endsWith(join('lib', 'repo-hint.ts')))
      .filter((f) => /\/mnt\/session\/resources/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });
});
