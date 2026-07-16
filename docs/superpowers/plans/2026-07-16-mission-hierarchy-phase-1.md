# Mission Hierarchy Phase 1: Data Model + Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split each repo's shared "standing mission" into a **container** (a pure budget/concurrency envelope, never a unit of work, never listed anywhere) and one **leaf mission per issue** (a real Mission with its own tasks, same status lifecycle as a campaign). Ship this as backend-only: schema, `workOnIssue`, dispatcher, reconciler, and a data migration — no *visual* UI change (Repo Workspace and `/missions` render identically to today; Phase 2 is their visual/UX rework), but Repo Workspace's data-fetching query does need a fix, since its task data moves off the container onto issue leaves.

**Architecture:** `missions` gains two nullable columns (`parentMissionId`, `issueRef`). The existing `getOrCreateWorkspaceMission`/`findWorkspaceMission` functions are kept exactly as-is and now represent "get or create the container" (a container is structurally identical to today's standing mission — the only change is what sits *underneath* it). A new layer, `getOrCreateIssueMission`, sits on top: it finds-or-creates-or-reopens the specific issue's leaf mission, calling the existing container function first. The dispatcher and reconciler are updated so containers (zero tasks, by construction) never get in the way, and issue leaves behave exactly like campaigns for concurrency, budget, and completion.

**Tech Stack:** Drizzle ORM + libSQL/Turso (`packages/db`), Fastify tick service (`apps/tick`), Next.js server actions (`apps/web`), vitest.

## Global Constraints

- No *visual* change in this phase. `/missions` and the Repo Workspace keep rendering exactly as they do today; Phase 2 (a separate plan) redesigns their display around the new shape. The one required data-layer fix to preserve today's rendered output: Repo Workspace's task query (Task 8) must be updated, since tasks move off the container onto issue leaves — without this fix, the page would silently show zero tasks for every issue.
- A **container** mission: `workspaceRepo` set, `issueRef` null, `parentMissionId` null, owns zero tasks. It is exactly what `getOrCreateWorkspaceMission` already creates today — do not rename or restructure that function.
- An **issue leaf** mission: `workspaceRepo` set, `issueRef` set (format `"owner/repo#123"`, matching `tasks.issueRef`), `parentMissionId` set to its container's id, owns tasks directly.
- A **campaign** mission (unchanged): `workspaceRepo` null, `parentMissionId` null, owns tasks directly.
- "Work again" on an issue whose leaf mission already reached `completed`/`cancelled` **reopens that same mission** (status back to `running`, `completedAt` cleared) rather than minting a new one — an issue's full work history lives in one mission across its lifetime.
- `mission-shape.ts`'s public API (`isCampaignMission`, `isStandingMission`, `missionShapeLabel`) is **not touched** in this phase — it has consumers in `apps/web/src/app/(app)/missions/page.tsx` and `apps/web/src/lib/home.ts` that are Phase 2's job to update. The one exception: `listMissions()`/`listMissionsForUser()` gain a container-exclusion filter (Task 4) — a narrow, load-bearing safety fix (a container must never appear as a row, in any phase), not a UI redesign.
- Budget aggregation across a container's children (summed spend checked against the container's `budgetUsd`/`budgetTokens`) is **out of scope for this phase** — `apps/tick/src/budgets.ts`'s existing per-mission logic already works correctly for issue leaves exactly as it does for campaigns (a leaf's own budget gates its own spend); only the container-level *aggregate* ceiling is deferred, since it requires deciding how crossing it cascades to children, a real design question left for a follow-up. Concurrency rollup (Task 5) IS in scope, since without it, per-leaf `concurrencyCap` defaults (5 each) would let a repo with many issues dispatch far more concurrent sessions than today's shared cap intended — a real behavioral regression if left unaddressed.
- The per-tick container concurrency check (Task 5) is a snapshot computed once per `runDispatcher` call, not perfectly atomic across siblings claimed within the same tick — two sibling issue missions under a busy container could each be handed the same remaining-slots ceiling and jointly claim slightly over cap in one tick. The next tick's fresh snapshot self-corrects. This is a stated, accepted simplification, not a bug to chase in this phase.
- Spec: `docs/superpowers/specs/2026-07-16-mission-hierarchy-design.md`.
- Run all commands from the repo root `/Users/paulmeller/Projects/agentstep/agentstep-forge`.

---

### Task 1: Schema — `parentMissionId` + `issueRef` columns + migration

**Files:**
- Modify: `packages/db/src/schema.ts` (the `missions` table, ~line 83-136)
- Create: `packages/db/migrations/00XX_mission_hierarchy.sql` (generated, see Step 2)

**Interfaces:**
- Produces: `missions.parentMissionId: string | null`, `missions.issueRef: string | null` on the `Mission`/`NewMission` inferred types.

- [ ] **Step 1: Add the columns**

In `packages/db/src/schema.ts`, inside the `missions` table definition, update the `workspaceRepo` field's doc comment (it currently says the reconciler must never auto-complete anything with it set — that's about to become false; Task 6 narrows this) and add two new fields right after it, before `concurrencyCap`:

```ts
  /**
   * Set for any repo-scoped Mission (both the repo's container and its
   * issue leaves — see `issueRef`/`parentMissionId` below for which is
   * which). Null for ordinary composer-authored campaign missions.
   */
  workspaceRepo: text('workspace_repo'),
  /**
   * Set only on an issue leaf Mission (format "owner/repo#123", matching
   * `tasks.issueRef`) — the specific issue this Mission's tasks belong to.
   * Null on the repo's container Mission and on campaigns.
   */
  issueRef: text('issue_ref'),
  /**
   * Self-referential: set on an issue leaf Mission, pointing at its repo's
   * container. Null on containers and on campaigns (both are always
   * roots). A container has `workspaceRepo` set, `issueRef` null, and
   * `parentMissionId` null, owns zero tasks, and must never appear as a
   * row anywhere — see mission-shape.ts (Phase 2) and listMissions()
   * (Task 4 of this plan).
   */
  parentMissionId: text('parent_mission_id'),
```

- [ ] **Step 2: Generate and inspect the migration**

Run: `cd packages/db && DATABASE_URL=file:local.db pnpm db:generate`

As with the `workspace_repo` migration before it, this repo's migration-snapshot chain has known gaps and `db:generate` may emit spurious statements for columns that already exist. Open the generated file in `packages/db/migrations/` and keep ONLY the statements adding `issue_ref` and `parent_mission_id` to `missions`. It should end up looking like:

```sql
ALTER TABLE `missions` ADD `issue_ref` text;
ALTER TABLE `missions` ADD `parent_mission_id` text;
```

- [ ] **Step 3: Apply and verify**

Run: `cd packages/db && DATABASE_URL=file:local.db pnpm db:migrate`
Expected: `done`, no errors.

Run: `sqlite3 packages/db/local.db ".schema missions" | grep -E "issue_ref|parent_mission_id"`
Expected: two lines showing the new columns.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @forge/db typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations/
git commit -m "feat(missions): add issueRef and parentMissionId columns"
```

---

### Task 2: `getOrCreateIssueMission` — container-aware issue leaf lookup/create/reopen (TDD)

**Files:**
- Modify: `apps/web/src/lib/workspace-mission.ts`
- Modify: `apps/web/src/lib/workspace-mission.test.ts`

**Interfaces:**
- Consumes: `getOrCreateWorkspaceMission` (existing, unchanged — now understood as "get or create the container"), `MissionDefaults` (existing, `./mission-defaults`).
- Produces:
  ```ts
  export type IssueMissionDeps = {
    findExistingIssue: (userId: string, repo: string, issueRef: string) => Promise<Mission | null>;
    reopenMission: (id: string) => Promise<Mission>;
    getOrCreateContainer: (userId: string, repo: string, defaults: MissionDefaults) => Promise<Mission>;
    insertMission: (values: NewMission) => Promise<Mission>;
  };
  export function dbFindExistingIssueMission(userId: string, repo: string, issueRef: string): Promise<Mission | null>;
  export function dbReopenMission(id: string): Promise<Mission>;
  export function getOrCreateIssueMission(
    userId: string,
    repo: string,
    issueRef: string,
    defaults: MissionDefaults,
    deps?: IssueMissionDeps,
  ): Promise<Mission>;
  ```

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/lib/workspace-mission.test.ts`, first update the existing `fakeMission` helper to include the two new nullable columns (required now that `Mission`'s inferred type includes them) — add these two lines to its returned object, right after `workspaceRepo: 'acme/api',`:

```ts
    workspaceRepo: 'acme/api',
    issueRef: null,
    parentMissionId: null,
```

Then add the import and new test suite. Change the top import line from:

```ts
import { getOrCreateWorkspaceMission } from './workspace-mission';
```

to:

```ts
import { getOrCreateIssueMission, getOrCreateWorkspaceMission } from './workspace-mission';
```

Append this at the end of the file:

```ts
describe('getOrCreateIssueMission', () => {
  it('returns the existing active issue mission without touching the container or inserting', async () => {
    const existing = fakeMission({
      id: 'msn_issue_existing',
      issueRef: 'acme/api#42',
      parentMissionId: 'msn_container',
    });
    const findExistingIssue = vi.fn().mockResolvedValue(existing);
    const reopenMission = vi.fn();
    const getOrCreateContainer = vi.fn();
    const insertMission = vi.fn();

    const result = await getOrCreateIssueMission('usr_1', 'acme/api', 'acme/api#42', defaults, {
      findExistingIssue,
      reopenMission,
      getOrCreateContainer,
      insertMission,
    });

    expect(result).toBe(existing);
    expect(findExistingIssue).toHaveBeenCalledWith('usr_1', 'acme/api', 'acme/api#42');
    expect(getOrCreateContainer).not.toHaveBeenCalled();
    expect(insertMission).not.toHaveBeenCalled();
    expect(reopenMission).not.toHaveBeenCalled();
  });

  it('reopens a completed issue mission instead of creating a new one', async () => {
    const existing = fakeMission({
      id: 'msn_issue_done',
      status: 'completed',
      issueRef: 'acme/api#42',
    });
    const reopened = fakeMission({ id: 'msn_issue_done', status: 'running', issueRef: 'acme/api#42' });
    const findExistingIssue = vi.fn().mockResolvedValue(existing);
    const reopenMission = vi.fn().mockResolvedValue(reopened);
    const getOrCreateContainer = vi.fn();
    const insertMission = vi.fn();

    const result = await getOrCreateIssueMission('usr_1', 'acme/api', 'acme/api#42', defaults, {
      findExistingIssue,
      reopenMission,
      getOrCreateContainer,
      insertMission,
    });

    expect(result).toBe(reopened);
    expect(reopenMission).toHaveBeenCalledWith('msn_issue_done');
    expect(getOrCreateContainer).not.toHaveBeenCalled();
    expect(insertMission).not.toHaveBeenCalled();
  });

  it('reopens a cancelled issue mission the same way as completed', async () => {
    const existing = fakeMission({
      id: 'msn_issue_cancelled',
      status: 'cancelled',
      issueRef: 'acme/api#7',
    });
    const reopened = fakeMission({ id: 'msn_issue_cancelled', status: 'running', issueRef: 'acme/api#7' });
    const findExistingIssue = vi.fn().mockResolvedValue(existing);
    const reopenMission = vi.fn().mockResolvedValue(reopened);

    const result = await getOrCreateIssueMission('usr_1', 'acme/api', 'acme/api#7', defaults, {
      findExistingIssue,
      reopenMission,
      getOrCreateContainer: vi.fn(),
      insertMission: vi.fn(),
    });

    expect(result).toBe(reopened);
    expect(reopenMission).toHaveBeenCalledWith('msn_issue_cancelled');
  });

  it('creates the container then inserts a new leaf mission when none exists', async () => {
    const container = fakeMission({ id: 'msn_container', issueRef: null, parentMissionId: null });
    const inserted = fakeMission({
      id: 'msn_issue_new',
      issueRef: 'acme/api#99',
      parentMissionId: 'msn_container',
    });
    const findExistingIssue = vi.fn().mockResolvedValue(null);
    const getOrCreateContainer = vi.fn().mockResolvedValue(container);
    const insertMission = vi.fn().mockResolvedValue(inserted);

    const result = await getOrCreateIssueMission('usr_1', 'acme/api', 'acme/api#99', defaults, {
      findExistingIssue,
      reopenMission: vi.fn(),
      getOrCreateContainer,
      insertMission,
    });

    expect(result).toBe(inserted);
    expect(getOrCreateContainer).toHaveBeenCalledWith('usr_1', 'acme/api', defaults);
    expect(insertMission).toHaveBeenCalledTimes(1);
    const values = insertMission.mock.calls[0]![0] as NewMission;
    expect(values.parentMissionId).toBe('msn_container');
    expect(values.issueRef).toBe('acme/api#99');
    expect(values.workspaceRepo).toBe('acme/api');
    expect(values.status).toBe('running');
    expect(values.plannerStrategy).toBe('rule-based');
    expect(values.agentId).toBe('agent_abc');
  });

  it('throws instead of inserting a leaf mission when no agent is configured', async () => {
    const container = fakeMission({ id: 'msn_container' });
    const noAgentDefaults: MissionDefaults = { ...defaults, agentId: null, source: 'none' };
    const findExistingIssue = vi.fn().mockResolvedValue(null);
    const getOrCreateContainer = vi.fn().mockResolvedValue(container);
    const insertMission = vi.fn();

    await expect(
      getOrCreateIssueMission('usr_1', 'acme/api', 'acme/api#1', noAgentDefaults, {
        findExistingIssue,
        reopenMission: vi.fn(),
        getOrCreateContainer,
        insertMission,
      }),
    ).rejects.toThrow(/no agent configured/i);

    expect(insertMission).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/web test -- workspace-mission`
Expected: FAIL — `getOrCreateIssueMission` is not exported.

- [ ] **Step 3: Write the implementation**

In `apps/web/src/lib/workspace-mission.ts`, update the doc comment on `getOrCreateWorkspaceMission` (it currently says "the reconciler must never auto-complete a mission with `workspaceRepo` set" — Task 6 narrows that to just containers):

```ts
/**
 * Get the repo's container Mission for this user, creating it if none
 * exists. A container never owns tasks and is never listed anywhere — it
 * exists only to hold the repo-wide `concurrencyCap`/budget that its issue
 * leaf missions (see `getOrCreateIssueMission`) share. The reconciler must
 * never auto-complete a container — see reconciler.ts.
 */
```

(No other change to `getOrCreateWorkspaceMission`'s body — it already creates exactly what a container needs.)

Append the new code at the end of the file:

```ts
export async function dbFindExistingIssueMission(
  userId: string,
  repo: string,
  issueRef: string,
): Promise<Mission | null> {
  const [row] = await db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.userId, userId),
        eq(missions.workspaceRepo, repo),
        eq(missions.issueRef, issueRef),
      ),
    )
    .orderBy(desc(missions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function dbReopenMission(id: string): Promise<Mission> {
  const now = new Date();
  const [updated] = await db
    .update(missions)
    .set({ status: 'running', completedAt: null, updatedAt: now })
    .where(eq(missions.id, id))
    .returning();
  if (!updated) throw new Error(`reopenMission: mission ${id} not found`);
  return updated;
}

export type IssueMissionDeps = {
  findExistingIssue: (userId: string, repo: string, issueRef: string) => Promise<Mission | null>;
  reopenMission: (id: string) => Promise<Mission>;
  getOrCreateContainer: (userId: string, repo: string, defaults: MissionDefaults) => Promise<Mission>;
  insertMission: (values: NewMission) => Promise<Mission>;
};

const defaultIssueMissionDeps: IssueMissionDeps = {
  findExistingIssue: dbFindExistingIssueMission,
  reopenMission: dbReopenMission,
  getOrCreateContainer: getOrCreateWorkspaceMission,
  insertMission: dbInsertMission,
};

/**
 * Get, reopen, or create the Mission for one specific issue in a repo.
 * Creates the repo's container Mission first if this is the first issue
 * ever worked there. "Work again" on an issue whose mission already
 * reached a terminal state reopens that same mission rather than minting
 * a new one — an issue's full work history lives in one place.
 */
export async function getOrCreateIssueMission(
  userId: string,
  repo: string,
  issueRef: string,
  defaults: MissionDefaults,
  deps: IssueMissionDeps = defaultIssueMissionDeps,
): Promise<Mission> {
  const existing = await deps.findExistingIssue(userId, repo, issueRef);
  if (existing) {
    if (existing.status === 'completed' || existing.status === 'cancelled') {
      return deps.reopenMission(existing.id);
    }
    return existing;
  }

  const container = await deps.getOrCreateContainer(userId, repo, defaults);

  if (!defaults.agentId) {
    throw new Error(
      'No agent configured. Connect GitHub in Setup, or set FORGE_DEFAULT_AGENT_ID.',
    );
  }

  const now = new Date();
  const values: NewMission = {
    id: `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    userId,
    name: `Issue — ${issueRef}`,
    goal: `Fix ${issueRef} in ${repo}.`,
    status: 'running',
    backend: 'managed-agents',
    agentId: defaults.agentId,
    plannerStrategy: 'rule-based',
    targetRepos: [repo],
    issueQuery: null,
    concurrencyCap: 5,
    budgetUsd: null,
    budgetTokens: null,
    budgetThresholdPct: 80,
    budgetHardStopPct: 100,
    taskMaxTurns: null,
    taskMaxTokens: null,
    noProgressTokens: null,
    webhookSecret: randomBytes(32).toString('hex'),
    githubInstallationId: defaults.githubInstallationId,
    githubVaultId: defaults.githubVaultId,
    skillId: null,
    aiReviewEnabled: false,
    selfVerifyEnabled: false,
    workspaceRepo: repo,
    issueRef,
    parentMissionId: container.id,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };

  return deps.insertMission(values);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @forge/web test -- workspace-mission`
Expected: PASS (all existing `getOrCreateWorkspaceMission` tests plus the 5 new `getOrCreateIssueMission` tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/workspace-mission.ts apps/web/src/lib/workspace-mission.test.ts
git commit -m "feat(missions): getOrCreateIssueMission — container-aware issue leaf lookup/reopen/create"
```

---

### Task 3: `workOnIssue` uses the issue leaf instead of the shared container

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts`

**Interfaces:**
- Consumes: `getOrCreateIssueMission` (Task 2).

- [ ] **Step 1: Update the import**

Change:

```ts
import { getOrCreateWorkspaceMission } from '@/lib/workspace-mission';
```

to:

```ts
import { getOrCreateIssueMission } from '@/lib/workspace-mission';
```

- [ ] **Step 2: Update `workOnIssue`**

Replace the mission-lookup block:

```ts
  let mission;
  try {
    const defaults = await resolveMissionDefaults(user.id);
    mission = await getOrCreateWorkspaceMission(user.id, repo, defaults);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not prepare mission' };
  }
```

with:

```ts
  const issueRef = `${repo}#${issue.number}`;

  let mission;
  try {
    const defaults = await resolveMissionDefaults(user.id);
    mission = await getOrCreateIssueMission(user.id, repo, issueRef, defaults);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not prepare mission' };
  }
```

Then, further down, the ledger event payload already recomputes the same string — replace its inline computation with the new `issueRef` variable:

```ts
      payload: { issueRef: `${repo}#${issue.number}`, taskIds: rows.map((r) => r.id) },
```

becomes:

```ts
      payload: { issueRef, taskIds: rows.map((r) => r.id) },
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 4: Run the existing test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass (no dedicated test file exists for `actions.ts`'s server actions, matching this project's convention — the logic it now calls, `getOrCreateIssueMission`, is fully covered by Task 2's tests).

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]/actions.ts"
git commit -m "feat(missions): workOnIssue creates/reopens the issue's own leaf mission"
```

---

### Task 4: `listMissions()` excludes containers

**Files:**
- Modify: `apps/web/src/lib/missions.ts`
- Create: `apps/web/src/lib/missions.test.ts`

**Interfaces:** none new — `listMissionsForUser`/`listMissions` keep their existing signatures; only their query changes.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/missions.test.ts`. This exercises the query against a real throwaway libSQL file, mirroring the pattern already used in `apps/tick/src/reconciler.test.ts` (point `DATABASE_URL` at a temp file before importing `./db`, migrate, then test):

```ts
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-missions-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let listMissionsForUser: typeof import('./missions').listMissionsForUser;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ listMissionsForUser } = await import('./missions'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

async function insertMission(id: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id,
    userId: 'user_1',
    name: 'Test mission',
    goal: 'test',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

describe('listMissionsForUser', () => {
  it('excludes a pure container (workspaceRepo set, no issueRef, no parent) but includes everything else', async () => {
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const issueLeafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const campaignId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await insertMission(containerId, { workspaceRepo: 'acme/api', issueRef: null, parentMissionId: null });
    await insertMission(issueLeafId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#1',
      parentMissionId: containerId,
    });
    await insertMission(campaignId, { workspaceRepo: null, issueRef: null, parentMissionId: null });

    const rows = await listMissionsForUser('user_1');
    const ids = rows.map((m) => m.id);

    expect(ids).not.toContain(containerId);
    expect(ids).toContain(issueLeafId);
    expect(ids).toContain(campaignId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @forge/web test -- missions.test`
Expected: FAIL — the container is currently returned (no exclusion filter exists yet).

- [ ] **Step 3: Add the exclusion filter**

In `apps/web/src/lib/missions.ts`, update the import line:

```ts
import { desc, eq } from 'drizzle-orm';
```

to:

```ts
import { and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
```

Then replace `listMissionsForUser`:

```ts
/** List missions for a specific user. */
export async function listMissionsForUser(userId: string): Promise<Mission[]> {
  return db
    .select()
    .from(missions)
    .where(eq(missions.userId, userId))
    .orderBy(desc(missions.createdAt));
}
```

with:

```ts
/**
 * List missions for a specific user — every campaign and issue leaf, but
 * never a repo's container (workspaceRepo set, issueRef null, no
 * parentMissionId — a pure budget/concurrency envelope, never a unit of
 * work). Expressed as "NOT a container": either it isn't repo-scoped at
 * all (campaign), or it's specifically issue-scoped (issueRef set), or it
 * has a parent itself (defensive — containers are always roots).
 */
export async function listMissionsForUser(userId: string): Promise<Mission[]> {
  return db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.userId, userId),
        or(
          isNull(missions.workspaceRepo),
          isNotNull(missions.issueRef),
          isNotNull(missions.parentMissionId),
        ),
      ),
    )
    .orderBy(desc(missions.createdAt));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @forge/web test -- missions.test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/missions.ts apps/web/src/lib/missions.test.ts
git commit -m "fix(missions): listMissions never returns a repo's container"
```

---

### Task 5: Dispatcher — container-aware concurrency

**Files:**
- Modify: `apps/tick/src/dispatcher.ts`
- Modify: `apps/tick/src/dispatcher.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function claimNextBatch(mission: Mission, maxSlots?: number): Promise<Task[]>; // maxSlots param added
  export function computeContainerCaps(
    runningMissions: Mission[],
    siblingInflightByParentId: Map<string, number>,
  ): Map<string, number>;
  ```

- [ ] **Step 1: Update the two Mission factories with the new nullable columns**

In `apps/tick/src/dispatcher.test.ts`, the `mission()` factory needs the two new columns (required now that `Mission`'s inferred type includes them). Add these two lines right after `workspaceRepo: null,`:

```ts
    workspaceRepo: null,
    issueRef: null,
    parentMissionId: null,
```

- [ ] **Step 2: Write the failing tests for `computeContainerCaps`**

Append to `apps/tick/src/dispatcher.test.ts`, after the existing `describe('claimNextBatch', ...)` block closes (before `describe('renderPrompt', ...)`):

```ts
describe('computeContainerCaps', () => {
  it('returns no cap for missions without a parent', () => {
    const campaign = mission({ id: 'msn_campaign' });
    const caps = computeContainerCaps([campaign], new Map());
    expect(caps.has('msn_campaign')).toBe(false);
  });

  it('caps a leaf mission by its container concurrencyCap minus sibling inflight', () => {
    const container = mission({ id: 'msn_container', concurrencyCap: 3 });
    const leaf = mission({ id: 'msn_leaf', parentMissionId: 'msn_container' });
    const caps = computeContainerCaps([container, leaf], new Map([['msn_container', 2]]));
    expect(caps.get('msn_leaf')).toBe(1);
  });

  it('floors at zero when sibling inflight already meets or exceeds the container cap', () => {
    const container = mission({ id: 'msn_container', concurrencyCap: 2 });
    const leaf = mission({ id: 'msn_leaf', parentMissionId: 'msn_container' });
    const caps = computeContainerCaps([container, leaf], new Map([['msn_container', 5]]));
    expect(caps.get('msn_leaf')).toBe(0);
  });

  it('ignores a leaf whose parent is not in the running-missions list', () => {
    const leaf = mission({ id: 'msn_leaf', parentMissionId: 'msn_missing_container' });
    const caps = computeContainerCaps([leaf], new Map());
    expect(caps.has('msn_leaf')).toBe(false);
  });

  it('gives every sibling under the same container the same remaining-slots ceiling', () => {
    const container = mission({ id: 'msn_container', concurrencyCap: 4 });
    const leafA = mission({ id: 'msn_leaf_a', parentMissionId: 'msn_container' });
    const leafB = mission({ id: 'msn_leaf_b', parentMissionId: 'msn_container' });
    const caps = computeContainerCaps([container, leafA, leafB], new Map([['msn_container', 1]]));
    expect(caps.get('msn_leaf_a')).toBe(3);
    expect(caps.get('msn_leaf_b')).toBe(3);
  });
});
```

Add `computeContainerCaps` to the import line:

```ts
import { claimNextBatch, depsSatisfied, dispatchOne, INFLIGHT_STATUSES } from './dispatcher';
```

becomes:

```ts
import { claimNextBatch, computeContainerCaps, depsSatisfied, dispatchOne, INFLIGHT_STATUSES } from './dispatcher';
```

- [ ] **Step 3: Write the failing tests for `claimNextBatch`'s `maxSlots` parameter**

First, extend the mock's shared state to support a `maxSlots` override. In the `mocks = vi.hoisted(...)` block, add one field to the `state` object right after `lastInflight: 0,`:

```ts
    lastInflight: 0,
    maxSlotsOverride: undefined as number | undefined,
```

Add the matching reset line right after `state.lastInflight = 0;`:

```ts
    state.lastInflight = 0;
    state.maxSlotsOverride = undefined;
```

Then update the `.limit()` handler's internal slot computation. Change:

```ts
          return {
            limit: vi.fn(async (limit: number) => {
              const rows = state.selectAllStatuses
                ? state.tasks
                : state.tasks.filter((task) => task.status === 'queued');
              const selected = rows.slice(0, limit);
              const slots = Math.max(0, state.concurrencyCap - state.lastInflight);
              state.selectedIdBatches.push(selected.slice(0, slots).map((task) => task.id));
              return selected;
            }),
          };
```

to:

```ts
          return {
            limit: vi.fn(async (limit: number) => {
              const rows = state.selectAllStatuses
                ? state.tasks
                : state.tasks.filter((task) => task.status === 'queued');
              const selected = rows.slice(0, limit);
              const ownSlots = Math.max(0, state.concurrencyCap - state.lastInflight);
              const slots =
                state.maxSlotsOverride !== undefined
                  ? Math.min(ownSlots, state.maxSlotsOverride)
                  : ownSlots;
              state.selectedIdBatches.push(selected.slice(0, slots).map((task) => task.id));
              return selected;
            }),
          };
```

Now update the `claim()` test helper to accept and forward an optional `maxSlots`:

```ts
async function claim(overrides: Partial<Mission> = {}): Promise<Task[]> {
  const currentMission = mission(overrides);
  mocks.state.concurrencyCap = currentMission.concurrencyCap;
  return claimNextBatch(currentMission);
}
```

becomes:

```ts
async function claim(overrides: Partial<Mission> = {}, maxSlots?: number): Promise<Task[]> {
  const currentMission = mission(overrides);
  mocks.state.concurrencyCap = currentMission.concurrencyCap;
  mocks.state.maxSlotsOverride = maxSlots;
  return claimNextBatch(currentMission, maxSlots);
}
```

Add two new tests inside `describe('claimNextBatch', ...)`, after the existing `it('claims only available slots under the concurrency cap', ...)` test:

```ts
  it('returns empty when maxSlots is 0, even though the mission concurrencyCap has room', async () => {
    mocks.state.countQueue = [0];
    mocks.state.tasks = [task('t1'), task('t2')];

    await expect(claim({ concurrencyCap: 3 }, 0)).resolves.toEqual([]);
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it('caps claimed tasks to maxSlots when it is more restrictive than the mission concurrencyCap', async () => {
    mocks.state.countQueue = [0];
    mocks.state.tasks = [task('t1'), task('t2'), task('t3')];

    const claimed = await claim({ concurrencyCap: 3 }, 1);

    expect(claimed.map((row) => row.id)).toEqual(['t1']);
  });
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @forge/tick test -- dispatcher`
Expected: FAIL — `computeContainerCaps` is not exported, and `claimNextBatch` doesn't yet accept a second argument.

- [ ] **Step 5: Implement `computeContainerCaps` and the `maxSlots` parameter**

In `apps/tick/src/dispatcher.ts`, add this exported function right after `depsSatisfied` (before `claimNextBatch`):

```ts
/**
 * For every currently-running mission that has a parent (an issue leaf
 * nested under a repo's container), computes how many of that container's
 * slots remain this tick, given the container's own concurrencyCap and how
 * many tasks are already inflight across ALL its children (siblings).
 * Missions with no parent are unconstrained and don't appear in the
 * result.
 *
 * Pure given its inputs — the caller (runDispatcher) queries the live
 * sibling-inflight counts once per tick and passes them in. This is a
 * per-tick snapshot, not perfectly atomic across siblings claimed within
 * the same tick — two siblings under a busy container could each be handed
 * the same remaining-slots ceiling and jointly claim slightly over cap in
 * one tick; the next tick's fresh snapshot self-corrects. Exported for
 * testing.
 */
export function computeContainerCaps(
  runningMissions: Mission[],
  siblingInflightByParentId: Map<string, number>,
): Map<string, number> {
  const byId = new Map(runningMissions.map((m) => [m.id, m]));
  const caps = new Map<string, number>();
  for (const mission of runningMissions) {
    if (!mission.parentMissionId) continue;
    const container = byId.get(mission.parentMissionId);
    if (!container) continue;
    const inflight = siblingInflightByParentId.get(mission.parentMissionId) ?? 0;
    caps.set(mission.id, Math.max(0, container.concurrencyCap - inflight));
  }
  return caps;
}
```

Update `claimNextBatch`'s signature and slot computation:

```ts
export async function claimNextBatch(mission: Mission): Promise<Task[]> {
  const inflightRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.missionId, mission.id), inArray(tasks.status, INFLIGHT_STATUSES)));
  const inflight = Number(inflightRows[0]?.count ?? 0);
  const slots = Math.max(0, mission.concurrencyCap - inflight);
  if (slots === 0) return [];
```

becomes:

```ts
export async function claimNextBatch(mission: Mission, maxSlots?: number): Promise<Task[]> {
  const inflightRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.missionId, mission.id), inArray(tasks.status, INFLIGHT_STATUSES)));
  const inflight = Number(inflightRows[0]?.count ?? 0);
  let slots = Math.max(0, mission.concurrencyCap - inflight);
  if (maxSlots !== undefined) slots = Math.min(slots, maxSlots);
  if (slots === 0) return [];
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @forge/tick test -- dispatcher`
Expected: PASS (all existing tests plus the 5 new `computeContainerCaps` tests and 2 new `maxSlots` tests).

- [ ] **Step 7: Wire it into `runDispatcher`**

In `apps/tick/src/dispatcher.ts`, replace `runDispatcher`'s body:

```ts
export async function runDispatcher(log: {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}): Promise<DispatchResult> {
  const runningMissions = await db.select().from(missions).where(eq(missions.status, 'running'));

  let totalClaimed = 0;
  let totalDispatched = 0;
  let totalFailed = 0;

  for (const mission of runningMissions) {
    const claimed = await claimNextBatch(mission);
```

with:

```ts
export async function runDispatcher(log: {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}): Promise<DispatchResult> {
  const runningMissions = await db.select().from(missions).where(eq(missions.status, 'running'));

  const parentIds = Array.from(
    new Set(runningMissions.map((m) => m.parentMissionId).filter((id): id is string => !!id)),
  );
  let siblingInflightByParentId = new Map<string, number>();
  if (parentIds.length > 0) {
    const rows = await db
      .select({ parentMissionId: missions.parentMissionId, count: sql<number>`count(*)` })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .where(
        and(inArray(missions.parentMissionId, parentIds), inArray(tasks.status, INFLIGHT_STATUSES)),
      )
      .groupBy(missions.parentMissionId);
    siblingInflightByParentId = new Map(
      rows
        .filter((r): r is typeof r & { parentMissionId: string } => !!r.parentMissionId)
        .map((r) => [r.parentMissionId, Number(r.count)]),
    );
  }
  const containerCaps = computeContainerCaps(runningMissions, siblingInflightByParentId);

  let totalClaimed = 0;
  let totalDispatched = 0;
  let totalFailed = 0;

  for (const mission of runningMissions) {
    const claimed = await claimNextBatch(mission, containerCaps.get(mission.id));
```

(The rest of `runDispatcher`'s body — the dispatch loop after `claimNextBatch` — is unchanged.)

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @forge/tick typecheck`
Expected: clean.

- [ ] **Step 9: Run the full tick test suite**

Run: `pnpm --filter @forge/tick test`
Expected: all suites pass.

- [ ] **Step 10: Commit**

```bash
git add apps/tick/src/dispatcher.ts apps/tick/src/dispatcher.test.ts
git commit -m "feat(dispatcher): container-aware concurrency for issue leaf missions"
```

---

### Task 6: Reconciler — containers never auto-complete, issue leaves do

**Files:**
- Modify: `apps/tick/src/reconciler.ts`
- Modify: `apps/tick/src/reconciler.test.ts`

**Interfaces:** none new — behavior change only.

- [ ] **Step 1: Update the existing test to reflect the new semantics**

In `apps/tick/src/reconciler.test.ts`, the existing test currently proves a `workspaceRepo`-having mission with terminal tasks never completes — under the new model, that's specifically true of a **container** (which never has tasks in the first place), not of an issue leaf (which should complete normally, same as a campaign). Replace the whole test:

```ts
  it('never completes a standing (workspaceRepo) mission even when all its tasks are terminal, while a regular mission with all-terminal tasks is completed in the same pass', async () => {
    const standingId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const regularId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await insertMission(standingId, { workspaceRepo: 'acme/api' });
    await insertTerminalTask(`tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`, standingId);

    await insertMission(regularId, { workspaceRepo: null });
    await insertTerminalTask(`tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`, regularId);

    await runReconciler(noopLog);

    expect((await getMission(standingId))!.status).toBe('running');
    expect((await getMission(regularId))!.status).toBe('completed');
  });
});
```

with:

```ts
  it('never completes a container (zero tasks by construction), while an issue leaf and a campaign with all-terminal tasks both complete in the same pass', async () => {
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const issueLeafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const campaignId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    // Container: workspaceRepo set, no issueRef, no parent, zero tasks.
    await insertMission(containerId, { workspaceRepo: 'acme/api', issueRef: null, parentMissionId: null });

    // Issue leaf: workspaceRepo set, issueRef set, parent = the container.
    await insertMission(issueLeafId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#1',
      parentMissionId: containerId,
    });
    await insertTerminalTask(`tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`, issueLeafId);

    await insertMission(campaignId, { workspaceRepo: null, issueRef: null, parentMissionId: null });
    await insertTerminalTask(`tsk_${randomUUID().replaceAll('-', '').slice(0, 12)}`, campaignId);

    await runReconciler(noopLog);

    expect((await getMission(containerId))!.status).toBe('running');
    expect((await getMission(issueLeafId))!.status).toBe('completed');
    expect((await getMission(campaignId))!.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @forge/tick test -- reconciler.test`
Expected: FAIL — the issue leaf is currently excluded from the candidates query (it has `workspaceRepo` set) and never completes.

- [ ] **Step 3: Narrow the auto-complete query**

In `apps/tick/src/reconciler.ts`, update the doc comment and query. Change:

```ts
  // (2) Complete Missions whose tasks are all in terminal states. Standing
  // (workspace) missions are fed incrementally by the repo workspace feature
  // and must never auto-complete just because their tasks are momentarily
  // all terminal, so they're excluded from the candidate set entirely.
  const candidates = await db
    .select()
    .from(missions)
    .where(and(eq(missions.status, 'running'), isNull(missions.workspaceRepo)));
```

to:

```ts
  // (2) Complete Missions whose tasks are all in terminal states. A repo's
  // container Mission (workspaceRepo set, issueRef null, parentMissionId
  // null) is fed by neither a planner nor "Work on it" directly — it owns
  // zero tasks by construction, so the existing "zero tasks, leave alone"
  // guard below already protects it without needing its own predicate.
  // Issue leaf missions and campaigns are both eligible here.
  const candidates = await db
    .select()
    .from(missions)
    .where(eq(missions.status, 'running'));
```

Note: the existing `isNull` import from `drizzle-orm` may become unused by this change — check the rest of the file (`grep -n "isNull" apps/tick/src/reconciler.ts`) before removing it from the import line; only remove it if this was its sole use.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @forge/tick test -- reconciler.test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @forge/tick typecheck`
Expected: clean.

- [ ] **Step 6: Run the full tick test suite**

Run: `pnpm --filter @forge/tick test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add apps/tick/src/reconciler.ts apps/tick/src/reconciler.test.ts
git commit -m "fix(reconciler): issue leaf missions auto-complete normally; only containers never do"
```

---

### Task 7: Migration/backfill — split existing standing missions into container + issue leaves

**Files:**
- Create: `packages/db/src/backfill-issue-missions.ts`

**Interfaces:**
- Produces: a standalone script, run via `tsx`, following the exact pattern of the existing `packages/db/src/migrate.ts`.

- [ ] **Step 1: Write the script**

Create `packages/db/src/backfill-issue-missions.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import { createDatabase } from './client';
import { missions, tasks } from './schema';

/**
 * One-time backfill: splits each existing standing mission (workspaceRepo
 * set, issueRef null, parentMissionId null, created before those columns
 * existed) into a container (the existing mission row, repurposed —
 * cheaper than deleting it and avoids orphaning its id from any ledger
 * events) plus one new issue leaf mission per distinct issueRef among its
 * tasks, re-pointing those tasks at their new leaf.
 *
 * Run with --dry-run first to see what it would do without writing
 * anything. Idempotent: a mission only qualifies as a candidate if it
 * currently has tasks directly attached AND both issueRef and
 * parentMissionId are still null — once split, the container has zero
 * directly-attached tasks left, so re-running the script is a no-op.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');

  const { db, client } = createDatabase({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

  const candidates = await db
    .select()
    .from(missions)
    .where(
      and(
        isNotNull(missions.workspaceRepo),
        isNull(missions.issueRef),
        isNull(missions.parentMissionId),
      ),
    );

  let containersCreated = 0;
  let leavesCreated = 0;
  let tasksRepointed = 0;

  for (const container of candidates) {
    const ownTasks = await db.select().from(tasks).where(eq(tasks.missionId, container.id));
    if (ownTasks.length === 0) continue; // already a container (or never had tasks) — nothing to split

    const byIssueRef = new Map<string, typeof ownTasks>();
    for (const task of ownTasks) {
      if (!task.issueRef) continue; // defensive: every standing-mission task should have one
      const bucket = byIssueRef.get(task.issueRef) ?? [];
      bucket.push(task);
      byIssueRef.set(task.issueRef, bucket);
    }

    console.log(
      `${dryRun ? '[dry-run] ' : ''}mission ${container.id} (${container.workspaceRepo}): ` +
        `${ownTasks.length} tasks across ${byIssueRef.size} issues`,
    );

    if (dryRun) {
      containersCreated += 1;
      leavesCreated += byIssueRef.size;
      tasksRepointed += ownTasks.length;
      continue;
    }

    await db.transaction(async (tx) => {
      const now = new Date();
      for (const [issueRef, issueTasks] of byIssueRef) {
        const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
        await tx.insert(missions).values({
          id: leafId,
          userId: container.userId,
          name: `Issue — ${issueRef}`,
          goal: `Fix ${issueRef} in ${container.workspaceRepo}.`,
          status: 'running',
          backend: container.backend,
          agentId: container.agentId,
          plannerStrategy: 'rule-based',
          targetRepos: container.targetRepos,
          issueQuery: null,
          concurrencyCap: container.concurrencyCap,
          budgetUsd: null,
          budgetTokens: null,
          budgetThresholdPct: container.budgetThresholdPct,
          budgetHardStopPct: container.budgetHardStopPct,
          taskMaxTurns: container.taskMaxTurns,
          taskMaxTokens: container.taskMaxTokens,
          noProgressTokens: container.noProgressTokens,
          webhookSecret: randomUUID().replaceAll('-', ''),
          githubInstallationId: container.githubInstallationId,
          githubVaultId: container.githubVaultId,
          skillId: container.skillId,
          aiReviewEnabled: container.aiReviewEnabled,
          selfVerifyEnabled: container.selfVerifyEnabled,
          workspaceRepo: container.workspaceRepo,
          issueRef,
          parentMissionId: container.id,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
        });
        leavesCreated += 1;

        for (const task of issueTasks) {
          await tx.update(tasks).set({ missionId: leafId, updatedAt: now }).where(eq(tasks.id, task.id));
          tasksRepointed += 1;
        }
      }
    });
    containersCreated += 1;
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}done: ${containersCreated} mission(s) split, ` +
      `${leavesCreated} issue leaf mission(s) created, ${tasksRepointed} task(s) re-pointed`,
  );
  client.close();
}

void main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/db typecheck`
Expected: clean.

- [ ] **Step 3: Dry-run against the real local database**

Run: `cd packages/db && DATABASE_URL=file:local.db npx tsx src/backfill-issue-missions.ts --dry-run`
Expected: output listing the two known existing standing missions (`msn_11daa0ea69ef40bb986d` "Issues — agentstep/product", `msn_00091dd099374af68262` "Issues — paulmeller/forge") each with their task/issue counts, and a `[dry-run] done: ...` summary line. No database rows should change — verify with `sqlite3 packages/db/local.db "SELECT COUNT(*) FROM missions;"` before and after, expecting identical counts.

- [ ] **Step 4: Run it for real against the local database**

Run: `cd packages/db && DATABASE_URL=file:local.db npx tsx src/backfill-issue-missions.ts`
Expected: `done: 2 mission(s) split, N issue leaf mission(s) created, M task(s) re-pointed`.

Verify: `sqlite3 packages/db/local.db "SELECT id, workspace_repo, issue_ref, parent_mission_id FROM missions WHERE workspace_repo IS NOT NULL;"` — the two original mission ids should now have `issue_ref` and `parent_mission_id` both NULL (containers), and one new row per distinct issue should show `issue_ref` set and `parent_mission_id` pointing at the matching original id.

Verify tasks re-pointed: `sqlite3 packages/db/local.db "SELECT DISTINCT mission_id FROM tasks WHERE repo IN ('agentstep/product','paulmeller/forge');"` — should now show multiple distinct mission ids (one per issue), not the original two container ids.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/backfill-issue-missions.ts
git commit -m "feat(missions): one-time backfill splitting standing missions into container + issue leaves"
```

---

### Task 8: Repo Workspace reads tasks across the container's issue leaves

**Files:**
- Modify: `apps/web/src/lib/tasks.ts`
- Create: `apps/web/src/lib/tasks.test.ts`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`

**Interfaces:**
- Produces: `listTasksForWorkspace(containerId: string): Promise<Task[]>`.

Today, `page.tsx` calls `listTasksForMission(mission.id)` where `mission` is the repo's container (via `findWorkspaceMission`, unchanged). Before this plan, the container itself owned every task directly, so this worked. After Tasks 2-3, all new (and, after Task 7's backfill, all existing) tasks live on issue leaf missions instead — the container now owns zero tasks by construction. Left unfixed, the Repo Workspace page would silently show zero tasks/progress for every issue, even ones actively being worked. This task fixes the query without changing anything visible — same rendered output, sourced correctly.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/tasks.test.ts`, following the same real-throwaway-database pattern used in `apps/web/src/lib/missions.test.ts` (Task 4):

```ts
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

const DB_FILE = `/tmp/forge-tasks-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let listTasksForWorkspace: typeof import('./tasks').listTasksForWorkspace;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ listTasksForWorkspace } = await import('./tasks'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

async function insertMission(id: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id,
    userId: 'user_1',
    name: 'Test mission',
    goal: 'test',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function insertTask(id: string, missionId: string) {
  const now = new Date();
  await db.insert(schema.tasks).values({
    id,
    missionId,
    repo: 'acme/api',
    baseBranch: 'main',
    kind: 'fix',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  });
}

describe('listTasksForWorkspace', () => {
  it('returns tasks from every issue leaf under the container, but none from the container itself', async () => {
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafAId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafBId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const otherContainerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const unrelatedLeafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await insertMission(containerId, { workspaceRepo: 'acme/api', issueRef: null, parentMissionId: null });
    await insertMission(leafAId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#1',
      parentMissionId: containerId,
    });
    await insertMission(leafBId, {
      workspaceRepo: 'acme/api',
      issueRef: 'acme/api#2',
      parentMissionId: containerId,
    });
    await insertMission(otherContainerId, { workspaceRepo: 'acme/other', issueRef: null, parentMissionId: null });
    await insertMission(unrelatedLeafId, {
      workspaceRepo: 'acme/other',
      issueRef: 'acme/other#1',
      parentMissionId: otherContainerId,
    });

    await insertTask('tsk_leaf_a', leafAId);
    await insertTask('tsk_leaf_b', leafBId);
    await insertTask('tsk_unrelated', unrelatedLeafId);

    const rows = await listTasksForWorkspace(containerId);
    const ids = rows.map((t) => t.id);

    expect(ids).toContain('tsk_leaf_a');
    expect(ids).toContain('tsk_leaf_b');
    expect(ids).not.toContain('tsk_unrelated');
  });

  it('returns an empty array for a container with no issue leaves yet', async () => {
    const emptyContainerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await insertMission(emptyContainerId, { workspaceRepo: 'acme/empty', issueRef: null, parentMissionId: null });

    const rows = await listTasksForWorkspace(emptyContainerId);
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @forge/web test -- tasks.test`
Expected: FAIL — `listTasksForWorkspace` is not exported.

- [ ] **Step 3: Implement `listTasksForWorkspace`**

In `apps/web/src/lib/tasks.ts`, update the imports:

```ts
import { asc, eq } from 'drizzle-orm';

import { tasks, type Task } from '@forge/db';
```

to:

```ts
import { asc, eq, inArray } from 'drizzle-orm';

import { missions, tasks, type Task } from '@forge/db';
```

Add this function after `listTasksForMission`:

```ts
/**
 * List every task belonging to any issue leaf mission under a repo's
 * container — what the Repo Workspace page shows. A container owns no
 * tasks directly (see workspace-mission.ts), so this walks its children
 * first rather than querying tasks.missionId against the container's own
 * id (which would always be empty).
 */
export async function listTasksForWorkspace(containerId: string): Promise<Task[]> {
  const children = await db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.parentMissionId, containerId));
  if (children.length === 0) return [];

  return db
    .select()
    .from(tasks)
    .where(inArray(tasks.missionId, children.map((c) => c.id)))
    .orderBy(asc(tasks.createdAt));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @forge/web test -- tasks.test`
Expected: PASS.

- [ ] **Step 5: Wire it into the Repo Workspace page**

In `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`, update the import:

```ts
import { listTasksForMission } from '@/lib/tasks';
```

to:

```ts
import { listTasksForWorkspace } from '@/lib/tasks';
```

Then change:

```ts
  const mission = await findWorkspaceMission(user.id, repo);
  const tasks = mission ? await listTasksForMission(mission.id) : [];
```

to:

```ts
  const mission = await findWorkspaceMission(user.id, repo);
  const tasks = mission ? await listTasksForWorkspace(mission.id) : [];
```

(`mission` here is the container, per `findWorkspaceMission`'s unchanged behavior — `listTasksForWorkspace` correctly walks its children rather than querying tasks against the container's own id.)

- [ ] **Step 6: Typecheck and verify the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/repos/paulmeller/forge`
Expected: `307` or `200` (proves no 500/compile error; a real check against live data happens in Task 9's manual verification, after Task 7's backfill has run).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/tasks.ts apps/web/src/lib/tasks.test.ts "apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx"
git commit -m "fix(workspace): Repo Workspace reads tasks from issue leaves, not the empty container"
```

---

### Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run every workspace's test suite**

Run: `pnpm test`
Expected: all suites pass across `@forge/web`, `@forge/tick`, `@forge/db`.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: clean across all workspace packages.

- [ ] **Step 3: Confirm the Repo Workspace still works end-to-end (no visible change expected)**

Ask the operator to confirm, against the real local app (`http://localhost:3100`):

1. Visiting `/repos/paulmeller/forge` (or `/repos/agentstep/product`) still lists issues correctly, with existing "Work on it"/"Work again" buttons and status badges unchanged — this exercises `findWorkspaceMission` (now reading the container, post-backfill) and `listTasksForWorkspace`/`groupTasksByIssue` (Task 8's fix — reading tasks that live on issue leaves, not the container).
2. Clicking "Work on it" on an issue not yet worked in that repo creates a new leaf mission and dispatches normally (check `sqlite3 packages/db/local.db "SELECT id, issue_ref, parent_mission_id FROM missions ORDER BY created_at DESC LIMIT 3;"` shows the new leaf).
3. Clicking "Work again" on an already-fixed issue reopens its existing leaf mission (same mission id as before, `status` back to `running`) rather than creating a new one.
4. `/missions` still renders without error and does not show either container mission as a row (spot-check: `sqlite3 packages/db/local.db "SELECT id FROM missions WHERE issue_ref IS NULL AND parent_mission_id IS NULL AND workspace_repo IS NOT NULL;"` to get the container ids, then confirm neither appears in the `/missions` page).

- [ ] **Step 4: Report**

Summarize verification results (pass/fail per check) to the operator. Do not mark this task complete if any check fails.
