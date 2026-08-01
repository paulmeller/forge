# `.forge/policy.yml` and the Onboarding Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a repo's policy a reviewable file in its own repository, and refuse to dispatch against a repo until its operator has merged one.

**Architecture:** A Zod-validated `.forge/policy.yml` becomes the whole policy for a repo when present (file → database → defaults, whole-object at each step). One reader, `resolveRepoPolicy`, replaces the scattered policy reads. A new tick stage proposes the file by pull request, and `claimNextBatch` refuses to claim work for a repo that has not merged one.

**Tech Stack:** Next.js 16 App Router, Zod 4, Drizzle over libSQL, Octokit, `yaml` (already a dependency), vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-01-policy-file-and-onboarding-gate-design.md`. It governs.
- **The file is the WHOLE policy or it is absent.** Never merge file values field-by-field with database values.
- **An invalid file blocks dispatch. It never falls back to defaults.** A typo must not silently enable a gate the operator believed they had configured.
- **"Could not tell" is not "no policy."** A GitHub failure while resolving propagates; only a genuine 404 means absent. Same rule as `checkForgeBranch` (`server/tick/completion.ts`).
- Business logic lives in `lib/` or a focused `server/tick/` module; routes and sweeps stay thin.
- Every state change in a sweep is a compare-and-swap guarded on the observed value, and a non-idempotent side effect (opening a PR) claims the row **before** the effect.
- Mutation-test every behaviour: revert it, confirm a **specific named** test fails, restore. **Print the mutated source and confirm it changed before running** — no-op mutations have produced false green suites on this project.
- Report mutation results **per behaviour, never bundled**.
- Migrations are generated with `pnpm --filter @forge/db db:generate`, never hand-written. After generating, apply locally with `DATABASE_URL="file:$(pwd)/packages/db/local.db" pnpm --filter @forge/db db:migrate` — a merged schema change with an unapplied migration broke local dispatch once already.
- Run `pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test` before every commit; all three clean. Baseline is **1176 tests / 127 files**.
- If `apps/web/src/lib/api/schemas.ts` or any published enum changes, regenerate with `pnpm api:spec` from the repo root and commit the result, or `openapi.test.ts` fails.
- Do not extract secrets, read `.env*` for credential values, forge sessions or cookies, bypass authentication, or start a dev server to log in.

---

## File Structure

**Created**
- `apps/web/src/lib/policy-file.ts` — the `.forge/policy.yml` schema and a pure `parsePolicyFile(yaml)`
- `apps/web/src/lib/policy-file.test.ts`
- `apps/web/src/lib/repo-policy.ts` — `resolveRepoPolicy(repo)`: fetch, parse, precedence, per-tick cache
- `apps/web/src/lib/repo-policy.test.ts`
- `apps/web/src/server/tick/onboarding.ts` — proposes the PR, flips repos to active, re-gates on deletion
- `apps/web/src/server/tick/onboarding.test.ts`

**Modified**
- `packages/db/src/schema.ts` — `onboardingState`, `onboardingPrUrl` on `github_installation_repos`
- `packages/db/migrations/` — one generated migration (adds columns; grandfathers existing rows to `active`)
- `apps/web/src/server/tick/dispatcher.ts` — `claimNextBatch` skips non-active repos
- `apps/web/src/server/tick/tick.ts` — runs the onboarding stage
- `apps/web/src/server/tick/auto-merge-policy.ts` — delegates to `resolveRepoPolicy`
- `apps/web/src/app/(app)/setup/actions.ts` — connecting a repo sets `pending_onboarding`
- `apps/web/src/app/(app)/repos/[owner]/[repo]/settings-tab.tsx` — read-only when a file is present

---

## Task 1: The policy file format

Pure parsing, no GitHub, no database. Everything downstream depends on this shape, so it lands first and stays independently testable.

**Files:**
- Create: `apps/web/src/lib/policy-file.ts`
- Create: `apps/web/src/lib/policy-file.test.ts`

**Interfaces:**
- Produces:
```ts
export type ForgePolicy = {
  gates: { ci: boolean; selfVerify: boolean; aiReview: boolean };
  autoMerge: AutoMergePolicy;          // from '@forge/db'
  requirePlanApproval: boolean;
  budgets: { taskTokens: number | null; taskTurns: number | null; noProgressTokens: number | null };
  concurrencyCap: number | null;
};
export type ParseResult =
  | { ok: true; policy: ForgePolicy }
  | { ok: false; error: string };
export function parsePolicyFile(source: string): ParseResult;
export const DEFAULT_POLICY: ForgePolicy;
export function policyFileTemplate(opts: { repo: string; verifyCommand: string | null }): string;
```

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/policy-file.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, parsePolicyFile, policyFileTemplate } from './policy-file';

describe('parsePolicyFile', () => {
  it('parses a complete policy', () => {
    const res = parsePolicyFile(`
gates:
  ci: true
  selfVerify: false
  aiReview: true
autoMerge:
  enabled: true
  maxAdditions: 50
requirePlanApproval: false
budgets:
  taskTokens: 2000000
  taskTurns: 30
  noProgressTokens: 2000000
concurrencyCap: 3
`);
    expect(res).toEqual({
      ok: true,
      policy: {
        gates: { ci: true, selfVerify: false, aiReview: true },
        autoMerge: { enabled: true, maxAdditions: 50 },
        requirePlanApproval: false,
        budgets: { taskTokens: 2_000_000, taskTurns: 30, noProgressTokens: 2_000_000 },
        concurrencyCap: 3,
      },
    });
  });

  it('fills omitted sections from the safe defaults', () => {
    // A file that only pins one thing is valid; the rest takes the safe
    // default. This is NOT the database merge the spec forbids — it is
    // defaulting WITHIN the file, which keeps the file the whole policy.
    const res = parsePolicyFile('gates:\n  aiReview: false\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.policy.gates).toEqual({ ci: true, selfVerify: true, aiReview: false });
    expect(res.policy.autoMerge.enabled).toBe(false);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    // A typo must not read as "not configured". Silently ignoring
    // `autoMerge: enabld:` would leave auto-merge off while the operator
    // believes they enabled it — or worse, the reverse.
    const res = parsePolicyFile('autoMerg:\n  enabled: true\n');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/autoMerg/);
  });

  it('rejects a wrong type with a message naming the field', () => {
    const res = parsePolicyFile('gates:\n  ci: "yes"\n');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/gates\.ci/);
  });

  it('rejects malformed YAML without throwing', () => {
    const res = parsePolicyFile('gates:\n  ci: [unclosed\n');
    expect(res.ok).toBe(false);
  });

  it('treats an empty file as the safe defaults', () => {
    // An empty policy.yml is a deliberate "use defaults", not an error —
    // it is what the onboarding template degrades to if every line is
    // deleted, and defaults are safe (auto-merge off, all gates on).
    expect(parsePolicyFile('')).toEqual({ ok: true, policy: DEFAULT_POLICY });
  });

  it('defaults to auto-merge OFF and every gate ON', () => {
    expect(DEFAULT_POLICY.autoMerge.enabled).toBe(false);
    expect(DEFAULT_POLICY.gates).toEqual({ ci: true, selfVerify: true, aiReview: true });
  });
});

describe('policyFileTemplate', () => {
  it('round-trips through the parser', () => {
    // The file Forge proposes must be one Forge accepts. Without this the
    // onboarding PR can ship a file that blocks dispatch the moment it merges.
    const yaml = policyFileTemplate({ repo: 'acme/api', verifyCommand: 'pnpm test' });
    const res = parsePolicyFile(yaml);
    expect(res.ok).toBe(true);
  });

  it('proposes auto-merge off', () => {
    const yaml = policyFileTemplate({ repo: 'acme/api', verifyCommand: null });
    const res = parsePolicyFile(yaml);
    expect(res.ok && res.policy.autoMerge.enabled).toBe(false);
  });

  it('mentions the repo and the verify command it detected', () => {
    const yaml = policyFileTemplate({ repo: 'acme/api', verifyCommand: 'pnpm test' });
    expect(yaml).toContain('acme/api');
    expect(yaml).toContain('pnpm test');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/lib/policy-file.test.ts`
Expected: FAIL — cannot resolve `./policy-file`.

- [ ] **Step 3: Implement**

Create `apps/web/src/lib/policy-file.ts`:

```ts
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { AutoMergePolicy } from '@forge/db';

/**
 * The `.forge/policy.yml` format.
 *
 * `.strict()` throughout is the point, not pedantry: a policy file is how an
 * operator authorises autonomous merges, and an ignored typo (`autoMerg:`)
 * would read as "not configured" — leaving a gate in a state they believe
 * they changed. An unknown key is an error the repo page shows them.
 */
const autoMergeSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxAdditions: z.number().int().positive().optional(),
    maxDeletions: z.number().int().positive().optional(),
    maxFilesChanged: z.number().int().positive().optional(),
    requiredChecks: z.array(z.string()).optional(),
    allowedPathPatterns: z.array(z.string()).optional(),
    requireHumanApproval: z.boolean().optional(),
  })
  .strict();

const policySchema = z
  .object({
    gates: z
      .object({
        ci: z.boolean().default(true),
        selfVerify: z.boolean().default(true),
        aiReview: z.boolean().default(true),
      })
      .strict()
      .default({}),
    autoMerge: autoMergeSchema.default({}),
    requirePlanApproval: z.boolean().default(false),
    budgets: z
      .object({
        taskTokens: z.number().int().positive().nullable().default(null),
        taskTurns: z.number().int().positive().nullable().default(null),
        noProgressTokens: z.number().int().positive().nullable().default(null),
      })
      .strict()
      .default({}),
    concurrencyCap: z.number().int().positive().nullable().default(null),
  })
  .strict();

export type ForgePolicy = {
  gates: { ci: boolean; selfVerify: boolean; aiReview: boolean };
  autoMerge: AutoMergePolicy;
  requirePlanApproval: boolean;
  budgets: { taskTokens: number | null; taskTurns: number | null; noProgressTokens: number | null };
  concurrencyCap: number | null;
};

export type ParseResult = { ok: true; policy: ForgePolicy } | { ok: false; error: string };

/** Safe defaults: auto-merge off, every gate on. What an omitted file means. */
export const DEFAULT_POLICY: ForgePolicy = policySchema.parse({}) as ForgePolicy;

export function parsePolicyFile(source: string): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    return { ok: false, error: `invalid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  // An empty document parses to null/undefined — a deliberate "use defaults",
  // which is what the template degrades to if its body is deleted.
  if (raw === null || raw === undefined) return { ok: true, policy: DEFAULT_POLICY };

  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    return { ok: false, error };
  }
  return { ok: true, policy: parsed.data as ForgePolicy };
}

/**
 * The file Forge proposes in the onboarding pull request.
 *
 * Written as commented YAML rather than generated from the schema: the PR is
 * the operator's first real explanation of what Forge will do, so the comments
 * are the feature. Every value here is the safe default — merging it changes
 * nothing about how Forge behaves except that it may now run at all.
 */
export function policyFileTemplate(opts: { repo: string; verifyCommand: string | null }): string {
  const verify = opts.verifyCommand ?? '(none detected — set one in AGENTS.md)';
  return `# Forge policy for ${opts.repo}
#
# Merging this file authorises Forge to dispatch coding agents against this
# repository. Until it is merged, Forge does nothing here.
#
# This file is the complete policy for this repo: when it is present the
# Settings page shows these values read-only, and changing policy means
# changing this file. Detected verify command: ${verify}

gates:
  ci: true          # never merge without CI green
  selfVerify: true  # check the change against its acceptance criteria
  aiReview: true    # independent review of the diff

autoMerge:
  enabled: false    # every change waits for a human. Turn on deliberately.

requirePlanApproval: false

budgets:
  taskTokens: null        # null = use the deployment default
  taskTurns: null
  noProgressTokens: null

concurrencyCap: null      # null = use the deployment default
`;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && pnpm vitest run src/lib/policy-file.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Mutation-test, per behaviour**

One at a time. Print the mutated source, confirm it changed, run, record the named failing test, restore.

1. Change `.strict()` on `policySchema` to `.passthrough()` → **"rejects an unknown key rather than ignoring it"** must fail.
2. Change `enabled: z.boolean().default(false)` to `.default(true)` → **"defaults to auto-merge OFF and every gate ON"** and **"proposes auto-merge off"** must fail.

- [ ] **Step 6: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test
git add apps/web/src/lib/policy-file.ts apps/web/src/lib/policy-file.test.ts
git commit -m "feat(policy): the .forge/policy.yml format and its safe defaults"
```

---

## Task 2: Schema and migration

The two columns the gate needs, plus the grandfathering that stops an upgrade halting an existing fleet.

**Files:**
- Modify: `packages/db/src/schema.ts` (the `githubInstallationRepos` table, ~line 489)
- Create: one generated migration under `packages/db/migrations/`

**Interfaces:**
- Produces: `githubInstallationRepos.onboardingState` (`'pending_onboarding' | 'active'`), `githubInstallationRepos.onboardingPrUrl` (`text | null`)

- [ ] **Step 1: Add the columns**

In `packages/db/src/schema.ts`, inside the `githubInstallationRepos` table definition, after `repoPolicy`:

```ts
    /**
     * Whether Forge may dispatch against this repo yet.
     *
     * A newly connected repo is `pending_onboarding` until its operator merges
     * the proposed `.forge/policy.yml` — consent arrives before any agent runs
     * (#40). Repos connected before this shipped are grandfathered `active` by
     * the migration: an upgrade must not stop an existing fleet, and those
     * operators consented by using the product.
     */
    onboardingState: text('onboarding_state', { enum: ['pending_onboarding', 'active'] })
      .notNull()
      .default('pending_onboarding'),
    /** The proposal PR, so the repo page can link it and the sweep never opens a second. */
    onboardingPrUrl: text('onboarding_pr_url'),
```

- [ ] **Step 2: Generate the migration**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/db db:generate
```
Expected: a new `packages/db/migrations/00NN_*.sql` adding both columns.

- [ ] **Step 3: Add the grandfathering statement**

Append to the generated `.sql` file (this is the one hand-edit the constraint allows — an added statement, not a hand-written migration):

```sql
--> statement-breakpoint
-- Repos connected before the onboarding gate shipped keep working: an upgrade
-- must not stop an existing fleet dispatching, and those operators consented
-- by using the product. New rows take the column default instead.
UPDATE `github_installation_repos` SET `onboarding_state` = 'active';
```

- [ ] **Step 4: Apply and verify locally**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
DATABASE_URL="file:$(pwd)/packages/db/local.db" pnpm --filter @forge/db db:migrate
sqlite3 packages/db/local.db "pragma table_info(github_installation_repos);" | grep onboarding
sqlite3 packages/db/local.db "select onboarding_state, count(*) from github_installation_repos group by 1;"
```
Expected: both columns present; every existing row `active`.

- [ ] **Step 5: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test
git add packages/db/src/schema.ts packages/db/migrations
git commit -m "feat(db): onboarding state on connected repos, existing rows grandfathered"
```

---

## Task 3: The policy reader

One function, one precedence rule. This is the consolidation that stops policy resolving differently depending on which code path asks.

**Files:**
- Create: `apps/web/src/lib/repo-policy.ts`
- Create: `apps/web/src/lib/repo-policy.test.ts`

**Interfaces:**
- Consumes: `parsePolicyFile`, `DEFAULT_POLICY`, `ForgePolicy` (Task 1)
- Produces:
```ts
export type PolicyResolution =
  | { source: 'file' | 'database' | 'default'; policy: ForgePolicy }
  | { source: 'invalid'; error: string };
export async function resolveRepoPolicy(repo: string): Promise<PolicyResolution>;
export function clearRepoPolicyCache(): void;
```

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/repo-policy.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOctokit = vi.hoisted(() => ({ repos: { getContent: vi.fn() } }));
vi.mock('@octokit/rest', () => ({ Octokit: vi.fn(() => mockOctokit) }));

const mockDb = vi.hoisted(() => ({ rows: [] as Array<{ repoPolicy: unknown }> }));
vi.mock('./db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => mockDb.rows }) }),
    }),
  },
}));

import { clearRepoPolicyCache, resolveRepoPolicy } from './repo-policy';

function fileContent(body: string) {
  return { data: { content: Buffer.from(body).toString('base64'), encoding: 'base64' } };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRepoPolicyCache();
  mockDb.rows = [];
});

describe('resolveRepoPolicy', () => {
  it('uses the file when present', async () => {
    mockOctokit.repos.getContent.mockResolvedValue(fileContent('autoMerge:\n  enabled: true\n'));
    const res = await resolveRepoPolicy('acme/api');
    expect(res).toMatchObject({ source: 'file' });
    if (res.source !== 'file') return;
    expect(res.policy.autoMerge.enabled).toBe(true);
  });

  it('takes the WHOLE policy from the file, never merging database values', async () => {
    // The spec's central rule. A field-by-field merge would put the effective
    // policy in neither place and let the two disagree silently.
    mockDb.rows = [{ repoPolicy: { requirePlanApproval: true } }];
    mockOctokit.repos.getContent.mockResolvedValue(fileContent('requirePlanApproval: false\n'));
    const res = await resolveRepoPolicy('acme/api');
    if (res.source !== 'file') throw new Error('expected file');
    expect(res.policy.requirePlanApproval).toBe(false);
  });

  it('falls back to the database when the file is absent (404)', async () => {
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
    mockDb.rows = [{ repoPolicy: { requirePlanApproval: true } }];
    const res = await resolveRepoPolicy('acme/api');
    expect(res).toMatchObject({ source: 'database' });
    if (res.source !== 'database') return;
    expect(res.policy.requirePlanApproval).toBe(true);
  });

  it('falls back to defaults when neither file nor database row exists', async () => {
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
    const res = await resolveRepoPolicy('acme/api');
    expect(res).toMatchObject({ source: 'default' });
  });

  it('reports an invalid file rather than falling back', async () => {
    // Falling back here would enable defaults the operator believed they had
    // overridden — the failure mode a typo must never produce.
    mockOctokit.repos.getContent.mockResolvedValue(fileContent('autoMerg:\n  enabled: true\n'));
    const res = await resolveRepoPolicy('acme/api');
    expect(res.source).toBe('invalid');
    if (res.source !== 'invalid') return;
    expect(res.error).toMatch(/autoMerg/);
  });

  it('propagates a non-404 GitHub failure — "could not tell" is not "absent"', async () => {
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    await expect(resolveRepoPolicy('acme/api')).rejects.toThrow('boom');
  });

  it('caches within a tick', async () => {
    mockOctokit.repos.getContent.mockResolvedValue(fileContent('gates:\n  ci: true\n'));
    await resolveRepoPolicy('acme/api');
    await resolveRepoPolicy('acme/api');
    expect(mockOctokit.repos.getContent).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/lib/repo-policy.test.ts`
Expected: FAIL — cannot resolve `./repo-policy`.

- [ ] **Step 3: Implement**

Create `apps/web/src/lib/repo-policy.ts`:

```ts
import { Octokit } from '@octokit/rest';
import { eq } from 'drizzle-orm';

import { githubInstallationRepos, type RepoPolicy } from '@forge/db';

import { db } from './db';
import { env } from './env';
import { DEFAULT_POLICY, parsePolicyFile, type ForgePolicy } from './policy-file';

export const POLICY_FILE_PATH = '.forge/policy.yml';

export type PolicyResolution =
  | { source: 'file' | 'database' | 'default'; policy: ForgePolicy }
  | { source: 'invalid'; error: string };

// Per-tick cache, same shape and lifetime as agents-md.ts's: the tick resolves
// policy for the same repo once per stage, and a cold call is a GitHub round
// trip. Cleared explicitly by tests; a process restart clears it in production.
const cache = new Map<string, PolicyResolution>();

export function clearRepoPolicyCache(): void {
  cache.clear();
}

/**
 * The effective policy for a repo: file → database → defaults.
 *
 * Whole-object at each step. The file is the complete policy when present,
 * never a set of overrides merged onto database values — a merge model puts the
 * effective policy in neither place and lets the two disagree silently, which
 * is the failure this design exists to remove.
 */
export async function resolveRepoPolicy(repo: string): Promise<PolicyResolution> {
  const cached = cache.get(repo);
  if (cached) return cached;

  const resolved = await resolveUncached(repo);
  cache.set(repo, resolved);
  return resolved;
}

async function resolveUncached(repo: string): Promise<PolicyResolution> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) return { source: 'default', policy: DEFAULT_POLICY };

  let source: string | null = null;
  try {
    const { data } = await new Octokit({ auth: env.GITHUB_APP_TOKEN }).repos.getContent({
      owner,
      repo: name,
      path: POLICY_FILE_PATH,
    });
    if (!Array.isArray(data) && 'content' in data && typeof data.content === 'string') {
      source = Buffer.from(data.content, 'base64').toString('utf8');
    }
  } catch (err) {
    // A 404 is an answer: no file. Anything else means we could not tell, and
    // "could not tell" must not become "no policy" — the caller would apply
    // defaults to a repo whose operator had configured something else.
    if ((err as { status?: number }).status !== 404) throw err;
  }

  if (source !== null) {
    const parsed = parsePolicyFile(source);
    return parsed.ok
      ? { source: 'file', policy: parsed.policy }
      : { source: 'invalid', error: parsed.error };
  }

  const [row] = await db
    .select({ repoPolicy: githubInstallationRepos.repoPolicy })
    .from(githubInstallationRepos)
    .where(eq(githubInstallationRepos.repo, repo))
    .limit(1);

  const stored = row?.repoPolicy as RepoPolicy | null | undefined;
  if (stored) {
    return {
      source: 'database',
      policy: { ...DEFAULT_POLICY, requirePlanApproval: stored.requirePlanApproval },
    };
  }

  return { source: 'default', policy: DEFAULT_POLICY };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && pnpm vitest run src/lib/repo-policy.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-test, per behaviour**

1. Change the invalid branch to fall back — `return parsed.ok ? {...} : { source: 'default', policy: DEFAULT_POLICY }` → **"reports an invalid file rather than falling back"** must fail.
2. Change the catch to swallow everything (`if (false) throw err;`) → **"propagates a non-404 GitHub failure"** must fail.
3. Make the file branch merge with the database — return `{ ...dbPolicy, ...parsed.policy }` → **"takes the WHOLE policy from the file"** must fail.

- [ ] **Step 6: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test
git add apps/web/src/lib/repo-policy.ts apps/web/src/lib/repo-policy.test.ts
git commit -m "feat(policy): one reader with file → database → defaults precedence"
```

---

## Task 4: The dispatch gate

One guard, at the single point every dispatch funnels through.

**Files:**
- Modify: `apps/web/src/server/tick/dispatcher.ts` (`claimNextBatch`, ~line 162)
- Modify: `apps/web/src/server/tick/dispatcher.test.ts`

**Interfaces:**
- Consumes: `githubInstallationRepos.onboardingState` (Task 2)

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/server/tick/dispatcher.test.ts`, inside the existing top-level `describe`:

```ts
  it('claims nothing for a repo that has not merged its policy file', async () => {
    // Consent before action (#40): a newly connected repo is
    // pending_onboarding until its operator merges the proposed
    // .forge/policy.yml. The guard lives here because every dispatch funnels
    // through claimNextBatch — one place, not a status list to keep in sync.
    mocks.state.repoOnboarding = new Map([['acme/repo', 'pending_onboarding']]);
    const claimed = await claimNextBatch(mission(), 5);
    expect(claimed).toEqual([]);
  });

  it('claims normally once the repo is active', async () => {
    mocks.state.repoOnboarding = new Map([['acme/repo', 'active']]);
    const claimed = await claimNextBatch(mission(), 5);
    expect(claimed.length).toBeGreaterThan(0);
  });
```

Extend the test file's db mock so `github_installation_repos` lookups return `mocks.state.repoOnboarding`. Follow the mock's existing shape — if the current mock cannot express a second table, add the smallest branch that can, rather than reshaping it.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/dispatcher.test.ts`
Expected: FAIL — tasks are claimed for the pending repo.

- [ ] **Step 3: Implement**

In `apps/web/src/server/tick/dispatcher.ts`, inside `claimNextBatch`, before the claim UPDATE:

```ts
  // Consent before action (#40). A repo is not dispatchable until its operator
  // has merged the proposed .forge/policy.yml. This is the only gate: every
  // dispatch path reaches the claim below, so guarding here cannot be bypassed
  // by a caller that forgets to check.
  const [repoRow] = await db
    .select({ state: githubInstallationRepos.onboardingState })
    .from(githubInstallationRepos)
    .where(eq(githubInstallationRepos.repo, mission.workspaceRepo ?? ''))
    .limit(1);
  if (repoRow && repoRow.state !== 'active') return [];
```

Add `githubInstallationRepos` to the `@forge/db` import if absent.

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && pnpm vitest run src/server/tick/dispatcher.test.ts`
Expected: PASS.

Existing dispatcher tests may now claim nothing, because their fixtures have no `github_installation_repos` row. Note the guard skips only when a row EXISTS and is not active — a repo with no row is unaffected. If a test still fails, seed it `active` rather than weakening the guard.

- [ ] **Step 5: Mutation-test**

Remove the `if (repoRow && repoRow.state !== 'active') return [];` line → **"claims nothing for a repo that has not merged its policy file"** must fail. Print the mutated source first, then restore.

- [ ] **Step 6: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test
git add apps/web/src/server/tick/dispatcher.ts apps/web/src/server/tick/dispatcher.test.ts
git commit -m "feat(dispatch): refuse to claim work for a repo pending onboarding"
```

---

## Task 5: The onboarding stage

Proposes the file, flips the repo to active when it lands, re-gates when it is deleted.

**Files:**
- Create: `apps/web/src/server/tick/onboarding.ts`
- Create: `apps/web/src/server/tick/onboarding.test.ts`
- Modify: `apps/web/src/server/tick/tick.ts`

**Interfaces:**
- Consumes: `resolveRepoPolicy`, `POLICY_FILE_PATH` (Task 3), `policyFileTemplate` (Task 1), the schema columns (Task 2)
- Produces: `runOnboarding(log): Promise<OnboardingResult>` where `OnboardingResult = { reposChecked: number; prsOpened: number; activated: number; regated: number }`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/tick/onboarding.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOctokit = vi.hoisted(() => ({
  repos: { getContent: vi.fn(), get: vi.fn(), createOrUpdateFileContents: vi.fn() },
  git: { getRef: vi.fn(), createRef: vi.fn() },
  pulls: { create: vi.fn(), list: vi.fn() },
}));
vi.mock('@octokit/rest', () => ({ Octokit: vi.fn(() => mockOctokit) }));

const rows = vi.hoisted(() => ({ repos: [] as Array<Record<string, unknown>>, updates: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => rows.repos }) }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { rows.updates.push(v); } }) }),
  },
}));

import { runOnboarding } from './onboarding';

const noopLog = { info: () => {}, warn: () => {} };

beforeEach(() => {
  vi.clearAllMocks();
  rows.repos = [];
  rows.updates = [];
  mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
  mockOctokit.git.getRef.mockResolvedValue({ data: { object: { sha: 'base-sha' } } });
  mockOctokit.pulls.list.mockResolvedValue({ data: [] });
  mockOctokit.pulls.create.mockResolvedValue({ data: { html_url: 'https://github.com/acme/api/pull/5' } });
});

describe('runOnboarding', () => {
  it('opens a proposal PR for a pending repo with no file', async () => {
    rows.repos = [{ id: 'r1', repo: 'acme/api', onboardingState: 'pending_onboarding', onboardingPrUrl: null }];
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));

    const res = await runOnboarding(noopLog);

    expect(res.prsOpened).toBe(1);
    expect(mockOctokit.pulls.create).toHaveBeenCalledTimes(1);
    expect(rows.updates.some((u) => u.onboardingPrUrl === 'https://github.com/acme/api/pull/5')).toBe(true);
  });

  it('does not open a second PR when one is already recorded', async () => {
    // Opening a PR is not idempotent; a sweep that re-proposed every tick
    // would spam the operator's repo.
    rows.repos = [{ id: 'r1', repo: 'acme/api', onboardingState: 'pending_onboarding', onboardingPrUrl: 'https://github.com/acme/api/pull/5' }];
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));

    const res = await runOnboarding(noopLog);

    expect(res.prsOpened).toBe(0);
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('activates a pending repo once the file is on the default branch', async () => {
    rows.repos = [{ id: 'r1', repo: 'acme/api', onboardingState: 'pending_onboarding', onboardingPrUrl: 'https://x/pull/5' }];
    mockOctokit.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from('gates:\n  ci: true\n').toString('base64'), encoding: 'base64' },
    });

    const res = await runOnboarding(noopLog);

    expect(res.activated).toBe(1);
    expect(rows.updates.some((u) => u.onboardingState === 'active')).toBe(true);
  });

  it('does NOT activate on an invalid file', async () => {
    // Merging a file Forge cannot parse must not open the gate — the operator
    // would believe they had configured something Forge never read.
    rows.repos = [{ id: 'r1', repo: 'acme/api', onboardingState: 'pending_onboarding', onboardingPrUrl: 'https://x/pull/5' }];
    mockOctokit.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from('autoMerg:\n  enabled: true\n').toString('base64'), encoding: 'base64' },
    });

    const res = await runOnboarding(noopLog);

    expect(res.activated).toBe(0);
    expect(rows.updates.some((u) => u.onboardingState === 'active')).toBe(false);
  });

  it('re-gates an active repo whose file was deleted', async () => {
    // Deleting the file that authorises autonomous work stops autonomous work.
    rows.repos = [{ id: 'r1', repo: 'acme/api', onboardingState: 'active', onboardingPrUrl: null }];
    mockOctokit.repos.getContent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));

    const res = await runOnboarding(noopLog);

    expect(res.regated).toBe(1);
    expect(rows.updates.some((u) => u.onboardingState === 'pending_onboarding')).toBe(true);
  });

  it('leaves an active repo alone while its file is present', async () => {
    rows.repos = [{ id: 'r1', repo: 'acme/api', onboardingState: 'active', onboardingPrUrl: null }];
    mockOctokit.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from('gates:\n  ci: true\n').toString('base64'), encoding: 'base64' },
    });

    const res = await runOnboarding(noopLog);

    expect(res.regated).toBe(0);
    expect(rows.updates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/onboarding.test.ts`
Expected: FAIL — cannot resolve `./onboarding`.

- [ ] **Step 3: Implement**

Create `apps/web/src/server/tick/onboarding.ts`:

```ts
import { Octokit } from '@octokit/rest';
import { eq } from 'drizzle-orm';

import { githubInstallationRepos } from '@forge/db';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { policyFileTemplate } from '@/lib/policy-file';
import { POLICY_FILE_PATH, clearRepoPolicyCache, resolveRepoPolicy } from '@/lib/repo-policy';

type Logger = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };

export type OnboardingResult = {
  reposChecked: number;
  prsOpened: number;
  activated: number;
  regated: number;
};

const BRANCH = 'forge/onboarding';

/**
 * The consent gate (#40).
 *
 * A newly connected repo is `pending_onboarding`: Forge proposes
 * `.forge/policy.yml` by pull request and dispatches nothing until it lands.
 * Merging the PR IS the consent — there is no second switch to flip.
 *
 * The reverse also holds: an active repo whose file has been deleted returns
 * to pending. Deleting the file that authorises autonomous work should stop
 * autonomous work, rather than silently reverting to database policy.
 */
export async function runOnboarding(log: Logger): Promise<OnboardingResult> {
  // The policy cache is per-tick and this stage reads the same files the later
  // stages will; clear it so an activation decision cannot be made on a
  // resolution cached before the operator merged.
  clearRepoPolicyCache();

  const repos = await db.select().from(githubInstallationRepos).where(undefined as never);
  let prsOpened = 0;
  let activated = 0;
  let regated = 0;

  for (const row of repos) {
    const repo = row.repo as string;
    let resolution;
    try {
      resolution = await resolveRepoPolicy(repo);
    } catch (err) {
      // Could not tell. Change nothing: re-gating an active repo on a transient
      // GitHub failure would halt a working fleet.
      log.warn({ repo, err: err instanceof Error ? err.message : String(err) }, 'onboarding:resolve_failed');
      continue;
    }

    const hasValidFile = resolution.source === 'file';

    if (row.onboardingState === 'pending_onboarding') {
      if (hasValidFile) {
        await db
          .update(githubInstallationRepos)
          .set({ onboardingState: 'active' })
          .where(eq(githubInstallationRepos.id, row.id as string));
        activated += 1;
        log.info({ repo }, 'onboarding:activated');
        continue;
      }
      if (!row.onboardingPrUrl) {
        const url = await proposePolicyFile(repo, log);
        if (url) {
          await db
            .update(githubInstallationRepos)
            .set({ onboardingPrUrl: url })
            .where(eq(githubInstallationRepos.id, row.id as string));
          prsOpened += 1;
        }
      }
      continue;
    }

    // Active. Only a genuine absence re-gates: an invalid file blocks dispatch
    // through resolveRepoPolicy without unwinding the operator's consent.
    if (resolution.source === 'default' || resolution.source === 'database') {
      await db
        .update(githubInstallationRepos)
        .set({ onboardingState: 'pending_onboarding', onboardingPrUrl: null })
        .where(eq(githubInstallationRepos.id, row.id as string));
      regated += 1;
      log.info({ repo }, 'onboarding:regated');
    }
  }

  return { reposChecked: repos.length, prsOpened, activated, regated };
}

/** Open the proposal PR. Returns its URL, or null if it could not be opened. */
async function proposePolicyFile(repo: string, log: Logger): Promise<string | null> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) return null;
  const gh = new Octokit({ auth: env.GITHUB_APP_TOKEN });

  try {
    const { data: repoData } = await gh.repos.get({ owner, repo: name });
    const base = repoData.default_branch;

    // An existing open PR from our branch is reused rather than duplicated —
    // the sweep runs every tick and opening a PR is not idempotent.
    const { data: open } = await gh.pulls.list({ owner, repo: name, head: `${owner}:${BRANCH}`, state: 'open' });
    if (open.length > 0) return open[0]!.html_url;

    const { data: ref } = await gh.git.getRef({ owner, repo: name, ref: `heads/${base}` });
    await gh.git.createRef({ owner, repo: name, ref: `refs/heads/${BRANCH}`, sha: ref.object.sha });

    await gh.repos.createOrUpdateFileContents({
      owner,
      repo: name,
      path: POLICY_FILE_PATH,
      branch: BRANCH,
      message: 'Forge: propose agent policy for this repository',
      content: Buffer.from(policyFileTemplate({ repo, verifyCommand: null })).toString('base64'),
    });

    const { data: pr } = await gh.pulls.create({
      owner,
      repo: name,
      base,
      head: BRANCH,
      title: 'Forge: configure autonomous agent policy',
      body: [
        'Forge is connected to this repository but **will not run** until this pull request is merged.',
        '',
        'This file is the complete policy for this repo: which gates every change must pass, whether anything may merge without a human, and the budgets a run may spend. Auto-merge is proposed **off** — every change waits for a person until you decide otherwise.',
        '',
        'Merging authorises Forge to dispatch agents here. Closing it without merging leaves Forge dormant.',
      ].join('\n'),
    });
    return pr.html_url;
  } catch (err) {
    log.warn({ repo, err: err instanceof Error ? err.message : String(err) }, 'onboarding:propose_failed');
    return null;
  }
}
```

Replace `.where(undefined as never)` with the codebase's idiom for "select all rows" from that table — check a neighbouring sweep in `reconciler.ts` and match it.

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && pnpm vitest run src/server/tick/onboarding.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into the tick**

In `apps/web/src/server/tick/tick.ts`, add the stage after `poller` and before `dispatcher`, following the existing wrapped-stage shape:

```ts
  const onboarding = await runOnboarding(log).catch((err) => {
    log.warn({ err: String(err) }, 'tick:onboarding_failed');
    return null;
  });
```

Include `onboarding` in the returned result object alongside the other stages.

- [ ] **Step 6: Mutation-test, per behaviour**

1. Change the pending branch to activate on any resolution (drop the `hasValidFile` check) → **"does NOT activate on an invalid file"** must fail.
2. Remove the `if (!row.onboardingPrUrl)` guard → **"does not open a second PR when one is already recorded"** must fail.
3. Change the re-gate branch to include `'invalid'` → **"leaves an active repo alone while its file is present"** still passes, so instead assert the narrower case: make it re-gate on `resolution.source !== 'file'` and confirm a test covering an active repo with an invalid file. If no such test exists, add one asserting an invalid file does not re-gate, then mutate.

- [ ] **Step 7: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test
git add apps/web/src/server/tick/onboarding.ts apps/web/src/server/tick/onboarding.test.ts apps/web/src/server/tick/tick.ts
git commit -m "feat(onboarding): propose the policy file, gate until it merges"
```

---

## Task 6: Connect the remaining consumers

Set `pending_onboarding` on connect, route auto-merge policy through the reader, show the state in the UI.

**Files:**
- Modify: `apps/web/src/app/(app)/setup/actions.ts`
- Modify: `apps/web/src/server/tick/auto-merge-policy.ts`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/settings-tab.tsx`
- Modify: `apps/web/src/server/tick/auto-merge-policy.test.ts`

**Interfaces:**
- Consumes: `resolveRepoPolicy` (Task 3), the schema columns (Task 2)

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/server/tick/auto-merge-policy.test.ts`:

```ts
  it('takes the auto-merge policy from the repo policy file when present', async () => {
    // One reader, one answer. Before this, policy resolved differently
    // depending on which code path asked — which is how #34 happened.
    mockResolveRepoPolicy.mockResolvedValue({
      source: 'file',
      policy: { ...DEFAULT_POLICY, autoMerge: { enabled: true, maxAdditions: 5 } },
    });
    await seedMission({ id: 'm_file', parentMissionId: null, workspaceRepo: 'acme/widgets' });

    expect(await resolveAutoMergePolicy('m_file')).toEqual({ enabled: true, maxAdditions: 5 });
  });
```

Mock `@/lib/repo-policy` in that test file with a hoisted `mockResolveRepoPolicy`, following the mocking idiom already used there.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/auto-merge-policy.test.ts`
Expected: FAIL — the file policy is ignored.

- [ ] **Step 3: Implement the three changes**

**a. `setup/actions.ts`** — when inserting a `github_installation_repos` row, set the new column explicitly:

```ts
        onboardingState: 'pending_onboarding',
```

with the comment:

```ts
        // Connecting a repo does not authorise dispatch (#40) — the operator
        // merges the proposed .forge/policy.yml first.
```

**b. `auto-merge-policy.ts`** — at the top of `resolveAutoMergePolicy`, once the mission's repo is known:

```ts
  // The policy file, when present, is the whole policy — including auto-merge.
  // Falling through to the column reads below only when there is no file keeps
  // one answer to "what is this repo's policy?".
  const repo = row.workspaceRepo ?? (row.targetRepos?.length === 1 ? row.targetRepos[0]! : null);
  if (repo) {
    const resolution = await resolveRepoPolicy(repo);
    if (resolution.source === 'file') return resolution.policy.autoMerge;
    if (resolution.source === 'invalid') return null; // invalid config never merges
  }
```

**c. `settings-tab.tsx`** — when the repo page's loader reports a policy file is present, render the current values read-only with a link to `.forge/policy.yml` on the default branch, and replace the Save button with that link. When the repo is `pending_onboarding`, show the onboarding PR link and the text: *"Forge will not run here until this pull request is merged."*

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && pnpm vitest run src/server/tick/auto-merge-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-test**

Change the invalid branch in `auto-merge-policy.ts` from `return null` to falling through to the column reads → add/confirm a test asserting an invalid file yields no auto-merge, and that test must fail. Print the mutated source first, then restore.

- [ ] **Step 6: Commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge
pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test
git add apps/web/src
git commit -m "feat(policy): route auto-merge through the reader; surface onboarding state"
```

---

## Final verification

- [ ] `pnpm --filter @forge/web typecheck && pnpm --filter @forge/web lint && pnpm --filter @forge/web test` all clean
- [ ] `pnpm --filter @forge/db db:generate` reports `No schema changes, nothing to migrate`
- [ ] `sqlite3 packages/db/local.db "select onboarding_state, count(*) from github_installation_repos group by 1;"` shows existing rows `active` — the grandfathering held
- [ ] `pnpm api:spec` produces no diff
- [ ] `grep -rn "repoPolicy" apps/web/src --include=*.ts | grep -v repo-policy.ts | grep -v '\.test\.'` — every remaining direct read of the column is deliberate and commented
- [ ] Every mutation listed in Tasks 1, 3, 4, 5 and 6 was run, with the mutated source printed to confirm the edit landed, and reported per behaviour rather than bundled
