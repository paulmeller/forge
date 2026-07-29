import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `disabledPaths` is an HTTP-surface control and nothing more. better-auth
 * enforces it in the router's `onRequest`, which only ever sees requests that
 * arrived through `toNextJsHandler(auth)` — so `auth.api.deviceApprove(...)`
 * and `auth.api.deviceDeny(...)` remain fully callable in-process, from a
 * Server Action, a route handler or a tick job, with the 404 never consulted.
 *
 * Those two endpoints are exactly the ones whose ownership guard —
 * `if (record.userId && record.userId !== session.user.id)` — cannot fire on a
 * freshly created row, whose `userId` is NULL. One in-process call re-opens
 * the original vulnerability in full: any signed-in user's approval binds the
 * row to themselves and `/device/token` hands the code-holder a session as
 * them.
 *
 * Nothing calls them today. This test is what makes that a property of the
 * codebase rather than a fact about one afternoon: it reads the actual source
 * tree, so it fails on the commit that introduces the call, not on the review
 * that might have caught it.
 *
 * Forge's only approval path is `decideDeviceRequest` in ./device-auth.ts.
 */

const SRC_ROOT = resolve(__dirname, '..');
const SELF = resolve(__filename);

/** The endpoint names, spelled so this file's own text cannot match itself. */
const FORBIDDEN = ['device' + 'Approve', 'device' + 'Deny'] as const;

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build']);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) continue;
    if (resolve(full) === SELF) continue;
    found.push(full);
  }
  return found;
}

/**
 * A *call site*, not a mention: a property access (`auth.api.deviceApprove`),
 * a bare or destructured invocation (`deviceApprove(...)`), or an indexed
 * lookup (`auth.api['deviceApprove']`). Prose is allowed to name the endpoint
 * — the comments in auth.ts, auth.test.ts and device-auth.ts have to, to
 * explain why it is off — so a bare-substring rule would either fail on the
 * documentation or force the documentation to stop saying what it means.
 */
function callSitePatterns(name: string): RegExp[] {
  return [
    new RegExp(`\\.\\s*${name}\\b`),
    new RegExp(`\\b${name}\\s*\\(`),
    new RegExp(`\\[\\s*['"\`]${name}['"\`]\\s*\\]`),
  ];
}

describe('the plugin approval endpoints have no in-process call site', () => {
  const files = sourceFiles(SRC_ROOT);

  it('reads a source tree that actually contains the app', () => {
    // Without this, a wrong SRC_ROOT or a broken walker would make every
    // assertion below vacuously true — the classic way a guard like this rots
    // into decoration.
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((f) => relative(SRC_ROOT, f))).toContain(join('lib', 'device-auth.ts'));
  });

  for (const name of FORBIDDEN) {
    it(`no file under apps/web/src calls ${name}`, () => {
      const patterns = callSitePatterns(name);
      const offenders = files.filter((file) => {
        const text = readFileSync(file, 'utf8');
        return patterns.some((p) => p.test(text));
      });
      expect(
        offenders.map((f) => relative(SRC_ROOT, f)),
        `${name} is disabled over HTTP by disabledPaths, but disabledPaths does not apply to ` +
          `auth.api. Calling it in-process restores the broken ownership guard. Approve through ` +
          `decideDeviceRequest (lib/device-auth.ts) instead.`,
      ).toEqual([]);
    });
  }
});
