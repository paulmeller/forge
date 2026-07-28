# Policy Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator configure the gating policies that are currently enforced in code but settable by nothing, so auto-merge stops being dead code.

**Architecture:** Add `resolveAutoMergePolicy` beside the existing `resolveGateFlags`, mirroring its live leaf-to-container inheritance exactly. Point `auto-merge.ts` and `reconciler.ts` at it so both agree about a leaf's policy. Extend the existing repo Settings tab and its ownership-scoped server action to write both policy objects.

**Tech Stack:** TypeScript, Next.js 16 (App Router, RSC, Server Actions), Drizzle ORM over libSQL/SQLite, shadcn/ui (new-york, radix base, lucide icons), Tailwind v4, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-policy-configuration-design.md`. It governs; this plan implements it.
- `resolveAutoMergePolicy` mirrors `resolveGateFlags` (`apps/web/src/server/tick/gate-flags.ts`) exactly: own row → parent if `parentMissionId` set and parent exists → own row as fallback.
- Live lookup, never copy-at-creation. Enabling auto-merge on a repo must immediately affect missions that already exist.
- `missionTerminalStatusesFor` **stays pure and synchronous**. Change its parameter to the already-resolved `AutoMergePolicy | null`; resolve at the caller. Do not make it async.
- `getRepoPolicy` fails **closed** on malformed data — anything other than a literal `false` is gated. Four mutation-killed tests pin this. Do not weaken it.
- `updateRepoSettings` keeps its shape: `withAuth()` first, explicit `return { ok: false, error }` (never throws), ownership scoping in the `WHERE` clause. A Server Action is a POST endpoint reachable without rendering the page — that scoping is the only guard.
- Blank textarea → the field is **omitted**, not stored as `[]`. "Unset" and "empty" must not diverge in meaning.
- UI copy must state plainly that `requireHumanApproval` permits **self-approval** — the mission owner may approve their own task. It is a "a human looked" control, not four-eyes.
- `requireHumanApproval` defaults **off**. `requirePlanApproval` stays **on**.
- No migration is expected — both columns already exist. If one somehow becomes necessary it must be generated with `pnpm --filter @forge/db db:generate` and its filename verified present in `packages/db/migrations/meta/_journal.json` by grep before commit. Never hand-create a migration file. Latest existing is `0019_futuristic_cable`.
- Every behaviour gets a test that fails against today's code. Each is mutation-tested: revert it, confirm a **specific named** test fails, restore. Report results **per behaviour, never bundled** — a bundled report on the previous branch misattributed which assertion failed and cost a review round.
- Run `pnpm typecheck && pnpm -r lint && pnpm -r test` before every commit. All three clean.
- Do not extract secrets, read `.env` files for credential values, forge sessions or auth cookies, or bypass authentication for any reason including "manual verification".

---

## File Structure

**Created**
- `apps/web/src/server/tick/auto-merge-policy.ts` — `resolveAutoMergePolicy`, the live container-inheritance resolver. Its own file rather than an addition to `gate-flags.ts`, because that file's `GateFlags` type is about the CI/verify gates and this is a different concern with a different consumer.
- `apps/web/src/server/tick/auto-merge-policy.test.ts` — resolver tests, modelled on `gate-flags.test.ts`.

**Modified**
- `apps/web/src/server/tick/auto-merge.ts` — resolve the policy instead of reading `row.mission.autoMergePolicy`
- `apps/web/src/server/tick/reconciler.ts` — `missionTerminalStatusesFor` takes a resolved policy; caller resolves
- `apps/web/src/app/(app)/repos/[owner]/[repo]/settings-actions.ts` — accept and validate the policy fields, write both tables
- `apps/web/src/app/(app)/repos/[owner]/[repo]/settings-tab.tsx` — render the policy controls
- `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx:155-161` — thread the new props

---

## Task 1: The resolver

**Files:**
- Create: `apps/web/src/server/tick/auto-merge-policy.ts`
- Create: `apps/web/src/server/tick/auto-merge-policy.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `resolveAutoMergePolicy(missionId: string): Promise<AutoMergePolicy | null>`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/server/tick/auto-merge-policy.test.ts`. Read `apps/web/src/server/tick/gate-flags.test.ts` first and copy its DB scaffold verbatim — same fixture style, same import shape, same cleanup.

```ts
import { describe, expect, it } from 'vitest';

import { resolveAutoMergePolicy } from './auto-merge-policy';

// Uses the same throwaway-libSQL scaffold as gate-flags.test.ts — copy its
// beforeAll/afterAll and seeding helpers rather than inventing new ones.

describe('resolveAutoMergePolicy', () => {
  it('returns a standalone mission its own policy', async () => {
    await seedMission({ id: 'm_solo', parentMissionId: null, autoMergePolicy: { enabled: true, maxAdditions: 10 } });
    expect(await resolveAutoMergePolicy('m_solo')).toEqual({ enabled: true, maxAdditions: 10 });
  });

  it("returns the CONTAINER's policy for an issue leaf, not the leaf's own", async () => {
    // The live-lookup property: enabling auto-merge on a repo must take
    // effect for leaves that already exist, without recreating them.
    await seedMission({ id: 'm_container', parentMissionId: null, autoMergePolicy: { enabled: true, maxAdditions: 5 } });
    await seedMission({ id: 'm_leaf', parentMissionId: 'm_container', autoMergePolicy: null });
    expect(await resolveAutoMergePolicy('m_leaf')).toEqual({ enabled: true, maxAdditions: 5 });
  });

  it("prefers the container's policy even when the leaf has one of its own", async () => {
    await seedMission({ id: 'm_c2', parentMissionId: null, autoMergePolicy: { enabled: false } });
    await seedMission({ id: 'm_l2', parentMissionId: 'm_c2', autoMergePolicy: { enabled: true } });
    expect(await resolveAutoMergePolicy('m_l2')).toEqual({ enabled: false });
  });

  it("falls back to the leaf's own policy when the parent row is missing", async () => {
    await seedMission({ id: 'm_orphan', parentMissionId: 'm_gone', autoMergePolicy: { enabled: true } });
    expect(await resolveAutoMergePolicy('m_orphan')).toEqual({ enabled: true });
  });

  it('returns null for a mission that does not exist', async () => {
    expect(await resolveAutoMergePolicy('m_missing')).toBeNull();
  });

  it('returns null when no policy is configured anywhere', async () => {
    await seedMission({ id: 'm_nopolicy', parentMissionId: null, autoMergePolicy: null });
    expect(await resolveAutoMergePolicy('m_nopolicy')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/auto-merge-policy.test.ts`
Expected: FAIL — cannot resolve `./auto-merge-policy`.

- [ ] **Step 3: Implement the resolver**

Create `apps/web/src/server/tick/auto-merge-policy.ts`:

```ts
import { eq } from 'drizzle-orm';

import { missions, type AutoMergePolicy } from '@forge/db';

import { db } from '@/lib/db';

/**
 * Resolve a Mission's auto-merge policy. Issue-leaf missions are created
 * without one while repo settings only ever update the *container* row, so
 * leaves read through to their parent — making the settings toggle live for
 * existing and future leaves alike. Standalone missions (no parent) use
 * their own; a missing parent falls back to the row's own.
 *
 * Deliberately a live lookup rather than a value copied at creation:
 * enabling auto-merge on a repo must free the Tasks already sitting in
 * `ready_to_merge`, which is exactly the population a copy would strand.
 *
 * Same convention as resolveGateFlags in gate-flags.ts. Shared by
 * auto-merge.ts and reconciler.ts so the two cannot disagree about whether
 * a Task is merge-eligible.
 */
export async function resolveAutoMergePolicy(
  missionId: string,
): Promise<AutoMergePolicy | null> {
  const [row] = await db
    .select({
      autoMergePolicy: missions.autoMergePolicy,
      parentMissionId: missions.parentMissionId,
    })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);
  if (!row) return null;

  if (row.parentMissionId) {
    const [parent] = await db
      .select({ autoMergePolicy: missions.autoMergePolicy })
      .from(missions)
      .where(eq(missions.id, row.parentMissionId))
      .limit(1);
    if (parent) return (parent.autoMergePolicy as AutoMergePolicy | null) ?? null;
  }

  return (row.autoMergePolicy as AutoMergePolicy | null) ?? null;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && pnpm vitest run src/server/tick/auto-merge-policy.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation-test the inheritance, per behaviour**

Each of these must be applied alone, confirmed, then reverted before the next:

1. Delete the whole `if (row.parentMissionId) { ... }` block → the leaf tests must fail.
2. Change `if (parent) return ...` to return the row's own policy instead → the "prefers the container's policy" test must fail.
3. Change the no-row branch from `return null` to `return { enabled: false }` → the missing-mission test must fail.

**Print the mutated source after each edit and confirm it actually changed before running.** A regex that silently matches nothing produces a green suite that proves nothing — this happened three times on the previous branch.

- [ ] **Step 6: Verify and commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add apps/web/src/server/tick/auto-merge-policy.ts apps/web/src/server/tick/auto-merge-policy.test.ts
git commit -m "feat(gating): resolve auto-merge policy through the container"
```

---

## Task 2: Point both consumers at the resolver

Both subsystems must agree about a leaf's policy. If `auto-merge.ts` resolves through the container while `reconciler.ts` reads the row directly, a leaf mission is treated as terminal by one and merge-pending by the other.

**Files:**
- Modify: `apps/web/src/server/tick/auto-merge.ts`
- Modify: `apps/web/src/server/tick/reconciler.ts`
- Test: `apps/web/src/server/tick/auto-merge.integration.test.ts`, `apps/web/src/server/tick/reconciler.test.ts`

**Interfaces:**
- Consumes: `resolveAutoMergePolicy(missionId): Promise<AutoMergePolicy | null>` (Task 1)
- Produces: `missionTerminalStatusesFor(policy: AutoMergePolicy | null): TaskStatus[]` — signature changed from taking a mission row

- [ ] **Step 1: Write the failing agreement test**

Add to `apps/web/src/server/tick/auto-merge.integration.test.ts`:

```ts
it('selects a leaf Task when only the CONTAINER has auto-merge enabled', async () => {
  // The whole point of the resolver: a repo-level toggle must reach the
  // issue-leaf missions that actually own the Tasks.
  await seedMission({ id: 'm_c', parentMissionId: null, autoMergePolicy: { enabled: true } });
  await seedMission({ id: 'm_l', parentMissionId: 'm_c', autoMergePolicy: null });
  await seedTask({ id: 'tsk_leaf', missionId: 'm_l', status: 'ready_to_merge', prUrl: PR_URL });

  const res = await runAutoMerge(log);
  expect(res.candidates).toBe(1);
});
```

Add to `apps/web/src/server/tick/reconciler.test.ts`:

```ts
describe('missionTerminalStatusesFor — takes a resolved policy', () => {
  it('treats ready_to_merge as terminal when the resolved policy is null', () => {
    expect(missionTerminalStatusesFor(null)).toContain('ready_to_merge');
  });

  it('treats ready_to_merge as terminal when the resolved policy is disabled', () => {
    expect(missionTerminalStatusesFor({ enabled: false })).toContain('ready_to_merge');
  });

  it('does NOT treat ready_to_merge as terminal when the resolved policy is enabled', () => {
    // Something will merge it; the Mission must stay open until it does.
    expect(missionTerminalStatusesFor({ enabled: true })).not.toContain('ready_to_merge');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/web && pnpm vitest run src/server/tick/auto-merge.integration.test.ts src/server/tick/reconciler.test.ts`
Expected: FAIL — auto-merge finds 0 candidates (it reads the leaf's own null policy), and `missionTerminalStatusesFor` rejects a bare policy argument.

- [ ] **Step 3: Change `missionTerminalStatusesFor` to take a resolved policy**

In `apps/web/src/server/tick/reconciler.ts`, replace the function (currently at lines 100-104) and update its doc comment's first line:

```ts
export function missionTerminalStatusesFor(
  policy: AutoMergePolicy | null,
): TaskStatus[] {
  if (policy?.enabled) return MISSION_TERMINAL_TASK_STATUSES;
  return [...MISSION_TERMINAL_TASK_STATUSES, 'ready_to_merge'];
}
```

It stays pure and synchronous — resolution happens at the caller, so this remains a directly-testable mapping. Delete `hasEnabledAutoMergePolicy` from `reconciler.ts` if it now has no other caller; keep it if `auto-merge.ts` still uses it.

- [ ] **Step 4: Resolve at the reconciler's caller**

In `runReconciler`, where `missionTerminalStatusesFor(mission)` is called during the mission-completion pass, resolve first:

```ts
const policy = await resolveAutoMergePolicy(mission.id);
const terminal = missionTerminalStatusesFor(policy);
```

Import `resolveAutoMergePolicy` from `./auto-merge-policy` and `AutoMergePolicy` from `@forge/db`.

- [ ] **Step 5: Resolve in auto-merge**

In `apps/web/src/server/tick/auto-merge.ts`'s `runAutoMerge` loop, replace the direct read:

```ts
    const policy = await resolveAutoMergePolicy(row.mission.id);
    if (!policy?.enabled) continue;
```

Remove the now-unused `row.mission.autoMergePolicy` read. `tryMerge` continues to take `policy` as a parameter — do not re-resolve inside it.

- [ ] **Step 6: Run the tests**

Run: `cd apps/web && pnpm vitest run src/server/tick/`
Expected: PASS.

- [ ] **Step 7: Mutation-test, per behaviour**

Applied one at a time, printing the mutated source each time to confirm the edit landed:

1. Revert `auto-merge.ts` to `row.mission.autoMergePolicy` → the leaf-selection test must fail.
2. Revert the reconciler caller to pass the mission row's raw policy → the agreement between subsystems breaks; a named test must fail.
3. Change `if (policy?.enabled)` to `if (policy)` in `missionTerminalStatusesFor` → the disabled-policy test must fail.

- [ ] **Step 8: Verify and commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add apps/web/src/server/tick
git commit -m "fix(gating): auto-merge and reconciler agree on a leaf's policy"
```

---

## Task 3: Write the policies from the Settings action

**Files:**
- Create: `apps/web/src/lib/parse-lines.ts`
- Create: `apps/web/src/lib/parse-lines.test.ts`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/settings-actions.ts`
- Test: `apps/web/src/app/(app)/repos/[owner]/[repo]/settings-actions.test.ts` (create if absent)

**Interfaces:**
- Consumes: `AutoMergePolicy`, `RepoPolicy` from `@forge/db`
- Produces: `updateRepoSettings(containerId, input)` where `input` gains `autoMerge: AutoMergePolicyInput` and `requirePlanApproval: boolean`; plus `parseLines(value: string): string[] | undefined` exported from `@/lib/parse-lines`

**Two corrections to this task, made before execution — read them before writing code:**

**(a) `parseLines` must NOT live in `settings-actions.ts`.** Next.js permits only **async function** exports from a `'use server'` module; every such file in this codebase exports types and async functions and nothing else. A synchronous `export function parseLines` there is a build error. It goes in `apps/web/src/lib/parse-lines.ts`, a plain module imported by both the action and the tab — which is also where it is easiest to unit-test.

**(b) `updateRepoSettings` must NOT take a `repo` parameter.** An earlier draft accepted `repo: string` from the client and wrote `WHERE githubInstallationRepos.repo = input.repo`, reasoning that the container's ownership check upstream made it safe. It does not: the ownership check validates the *mission*, while `repo` is an independent client-supplied field, so a caller could pass another account's repo and disable that account's plan-approval gate. A Server Action is a POST endpoint reachable by anyone.

Derive the repo server-side instead, from the container mission that was just ownership-checked. `missions.targetRepos` is a JSON `string[]` and repo containers are created with `targetRepos: [repo]` (`apps/web/src/lib/workspace-mission.ts:101,211`). Take `updated.targetRepos?.[0]` from the `.returning()` row and use that. Nothing client-supplied then selects which repo row is written.

- [ ] **Step 1: Write the failing tests**

Follow the `vi.mock('@/lib/with-auth')` scaffold in `apps/web/src/app/(app)/repos/[owner]/[repo]/actions.test.ts`.

```ts
describe('updateRepoSettings — policies', () => {
  it('writes the auto-merge policy to the container mission', async () => {
    const res = await updateRepoSettings('m_container', validInput({
      autoMerge: { enabled: true, maxAdditions: 50, requiredChecks: ['build'] },
    }));
    expect(res).toEqual({ ok: true });
    const m = await missionRow('m_container');
    expect(m.autoMergePolicy).toMatchObject({ enabled: true, maxAdditions: 50, requiredChecks: ['build'] });
  });

  it('writes requirePlanApproval to the repo row named by the container, not the mission', async () => {
    // m_container is seeded with targetRepos: ['a/b'].
    await updateRepoSettings('m_container', validInput({ requirePlanApproval: false }));
    expect((await repoRow('a/b')).repoPolicy).toEqual({ requirePlanApproval: false });
  });

  it('cannot be steered at another account\'s repo', async () => {
    // The repo is derived from the ownership-checked container, so there is
    // no caller-supplied field that selects which repo row is written. This
    // test pins that: it must remain impossible to express the attack.
    await seedRepoRow('victim/secret', { requirePlanApproval: true });
    await updateRepoSettings('m_container', validInput({ requirePlanApproval: false }));
    expect((await repoRow('victim/secret')).repoPolicy).toEqual({ requirePlanApproval: true });
  });

  it('omits empty lists rather than storing []', async () => {
    // "unset" and "empty" must not diverge: an empty allow-list would
    // otherwise read as "no path may change", blocking everything.
    await updateRepoSettings('m_container', validInput({
      autoMerge: { enabled: true, requiredChecks: undefined, allowedPathPatterns: undefined },
    }));
    const p = (await missionRow('m_container')).autoMergePolicy;
    expect(p).not.toHaveProperty('requiredChecks');
    expect(p).not.toHaveProperty('allowedPathPatterns');
  });

  it('refuses another user\'s container and writes nothing', async () => {
    const res = await updateRepoSettings('m_other_user', validInput({}));
    expect(res).toEqual({ ok: false, error: 'Repo settings not found' });
    expect((await missionRow('m_other_user')).autoMergePolicy).toBeNull();
  });

  it('rejects a negative diff cap', async () => {
    const res = await updateRepoSettings('m_container', validInput({ autoMerge: { enabled: true, maxAdditions: -1 } }));
    expect(res.ok).toBe(false);
  });
});

describe('parseLines', () => {
  it('trims, drops blanks, and returns undefined for an empty textarea', () => {
    expect(parseLines('  build \n\n  test  \n')).toEqual(['build', 'test']);
    expect(parseLines('   \n  \n')).toBeUndefined();
    expect(parseLines('')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/web && pnpm vitest run "src/app/(app)/repos/[owner]/[repo]/settings-actions.test.ts"`
Expected: FAIL — `updateRepoSettings` does not accept these fields.

- [ ] **Step 3: Add the line parser as its own module**

Create `apps/web/src/lib/parse-lines.ts` — NOT in `settings-actions.ts`, which is a
`'use server'` module and may only export async functions:

```ts
/**
 * Textarea → string list. Returns undefined (not []) for an empty box, so
 * an unset field is stored as omitted: an empty `allowedPathPatterns` would
 * otherwise mean "no path may change" and block every merge.
 */
export function parseLines(value: string): string[] | undefined {
  const lines = value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines : undefined;
}
```

- [ ] **Step 4: Extend the action**

Widen the input type and add validation in the existing explicit style, then write both tables:

```ts
export type AutoMergePolicyInput = {
  enabled: boolean;
  maxAdditions?: number;
  maxDeletions?: number;
  maxFilesChanged?: number;
  requiredChecks?: string[];
  allowedPathPatterns?: string[];
  requireHumanApproval?: boolean;
};

export async function updateRepoSettings(
  containerId: string,
  input: {
    concurrencyCap: number;
    budgetUsd: number | null;
    aiReviewEnabled: boolean;
    selfVerifyEnabled: boolean;
    autoMerge: AutoMergePolicyInput;
    requirePlanApproval: boolean;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await withAuth();
  // ...existing concurrencyCap and budgetUsd validation, unchanged...

  for (const [label, value] of [
    ['Max additions', input.autoMerge.maxAdditions],
    ['Max deletions', input.autoMerge.maxDeletions],
    ['Max files changed', input.autoMerge.maxFilesChanged],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      return { ok: false, error: `${label} must be a whole number of 0 or more, or blank` };
    }
  }

  const [updated] = await db
    .update(missions)
    .set({
      concurrencyCap: input.concurrencyCap,
      budgetUsd: input.budgetUsd,
      aiReviewEnabled: input.aiReviewEnabled,
      selfVerifyEnabled: input.selfVerifyEnabled,
      autoMergePolicy: input.autoMerge,
      updatedAt: new Date(),
    })
    .where(and(eq(missions.id, containerId), eq(missions.userId, user.id)))
    .returning();

  if (!updated) {
    return { ok: false, error: 'Repo settings not found' };
  }

  // requirePlanApproval governs Mission *creation*, so it cannot live on a
  // Mission — it stays on the repo row.
  //
  // The repo name is taken from the container we just ownership-checked, NOT
  // from a parameter. Accepting it from the caller would let someone pass
  // another account's repo alongside a container they legitimately own and
  // disable that account's plan-approval gate — the ownership check covers
  // the Mission, not an independent field beside it.
  const repo = (updated.targetRepos as string[] | null)?.[0];
  if (repo) {
    await db
      .update(githubInstallationRepos)
      .set({ repoPolicy: { requirePlanApproval: input.requirePlanApproval } })
      .where(eq(githubInstallationRepos.repo, repo));
  }

  return { ok: true };
}
```

Import `githubInstallationRepos` from `@forge/db`.

- [ ] **Step 5: Run the tests**

Run: `cd apps/web && pnpm vitest run "src/app/(app)/repos/[owner]/[repo]/settings-actions.test.ts"`
Expected: PASS.

- [ ] **Step 6: Mutation-test, per behaviour**

One at a time, printing the mutated source each time:

1. Drop `eq(missions.userId, user.id)` from the `WHERE` → the cross-user test must fail. This is the only auth guard on the action; if that test still passes, rewrite it.
2. Make `parseLines` return `[]` instead of `undefined` for an empty box → the omitted-lists test must fail.
3. Change the repo source from `updated.targetRepos?.[0]` back to a caller-supplied value (add a temporary `repo` parameter and use it) → the "cannot be steered at another account's repo" test must fail. This is the cross-account write the pre-flight scan caught; if that test still passes, it is not pinning the property and must be rewritten.
4. Move the `githubInstallationRepos` write above the ownership-checked mission update → the cross-user test must fail on the repo row too. If it does not, add an assertion so it does.

- [ ] **Step 7: Verify and commit**

```bash
cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test
git add apps/web/src/lib/parse-lines.ts apps/web/src/lib/parse-lines.test.ts "apps/web/src/app/(app)/repos/[owner]/[repo]/settings-actions.ts" "apps/web/src/app/(app)/repos/[owner]/[repo]/settings-actions.test.ts"
git commit -m "feat(settings): persist the auto-merge and plan-approval policies"
```

---

## Task 4: The Settings tab controls

**Files:**
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/settings-tab.tsx`
- Modify: `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx:155-161`

**Interfaces:**
- Consumes: `updateRepoSettings(containerId, input)` and `parseLines` (Task 3)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Add the props**

`SettingsTab` gains `autoMergePolicy: AutoMergePolicy | null` and `requirePlanApproval: boolean`. It does NOT gain a `repo` prop — the action derives the repo from the ownership-checked container itself. Seed state from them:

```tsx
const [amEnabled, setAmEnabled] = useState(autoMergePolicy?.enabled ?? false);
const [maxAdd, setMaxAdd] = useState(autoMergePolicy?.maxAdditions?.toString() ?? '');
const [maxDel, setMaxDel] = useState(autoMergePolicy?.maxDeletions?.toString() ?? '');
const [maxFiles, setMaxFiles] = useState(autoMergePolicy?.maxFilesChanged?.toString() ?? '');
const [checks, setChecks] = useState((autoMergePolicy?.requiredChecks ?? []).join('\n'));
const [paths, setPaths] = useState((autoMergePolicy?.allowedPathPatterns ?? []).join('\n'));
const [requireApproval, setRequireApproval] = useState(autoMergePolicy?.requireHumanApproval ?? false);
const [planApproval, setPlanApproval] = useState(requirePlanApproval);
```

- [ ] **Step 2: Render the controls**

Append inside the existing `FieldGroup`, above the Save `Field`. Use `Checkbox` (this file's established control — not `Switch`) and the `Textarea` from `@/components/ui/textarea`. A blank number input parses to `undefined`, never `0`.

```tsx
<Field orientation="horizontal">
  <Checkbox id="amEnabled" checked={amEnabled} onCheckedChange={(c) => setAmEnabled(c === true)} />
  <FieldLabel htmlFor="amEnabled" className="font-normal">Auto-merge</FieldLabel>
</Field>
<Field>
  <FieldLabel htmlFor="maxAdd">Max additions</FieldLabel>
  <Input id="maxAdd" type="number" min={0} placeholder="No cap" value={maxAdd} onChange={(e) => setMaxAdd(e.target.value)} />
</Field>
<Field>
  <FieldLabel htmlFor="maxDel">Max deletions</FieldLabel>
  <Input id="maxDel" type="number" min={0} placeholder="No cap" value={maxDel} onChange={(e) => setMaxDel(e.target.value)} />
</Field>
<Field>
  <FieldLabel htmlFor="maxFiles">Max files changed</FieldLabel>
  <Input id="maxFiles" type="number" min={0} placeholder="No cap" value={maxFiles} onChange={(e) => setMaxFiles(e.target.value)} />
</Field>
<Field>
  <FieldLabel htmlFor="checks">Required checks</FieldLabel>
  <Textarea id="checks" rows={3} placeholder="One check name per line" value={checks} onChange={(e) => setChecks(e.target.value)} />
  <FieldDescription>
    Blocks the merge unless the branch actually requires each of these. Leave blank to rely on
    branch protection alone.
  </FieldDescription>
</Field>
<Field>
  <FieldLabel htmlFor="paths">Allowed paths</FieldLabel>
  <Textarea id="paths" rows={3} placeholder="One glob per line, e.g. docs/**" value={paths} onChange={(e) => setPaths(e.target.value)} />
  <FieldDescription>Blank means any path may change.</FieldDescription>
</Field>
<Field orientation="horizontal">
  <Checkbox id="requireApproval" checked={requireApproval} onCheckedChange={(c) => setRequireApproval(c === true)} />
  <FieldLabel htmlFor="requireApproval" className="font-normal">Require human approval</FieldLabel>
</Field>
<FieldDescription>
  Only tasks someone approved will auto-merge. This records that a human looked — it does not
  require a second person, so you can approve your own work.
</FieldDescription>
<Field orientation="horizontal">
  <Checkbox id="planApproval" checked={planApproval} onCheckedChange={(c) => setPlanApproval(c === true)} />
  <FieldLabel htmlFor="planApproval" className="font-normal">Require plan approval for @forge</FieldLabel>
</Field>
<FieldDescription>
  When on, an @forge comment produces a plan you approve before any agent starts.
</FieldDescription>
```

- [ ] **Step 3: Send them on save**

In `handleSave`, build the policy — a blank box is `undefined`, not `0`:

```tsx
const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
const result = await updateRepoSettings(containerId, {
  concurrencyCap: parsedCap,
  budgetUsd: parsedBudget,
  aiReviewEnabled: aiReview,
  selfVerifyEnabled: selfVerify,
  autoMerge: {
    enabled: amEnabled,
    maxAdditions: num(maxAdd),
    maxDeletions: num(maxDel),
    maxFilesChanged: num(maxFiles),
    requiredChecks: parseLines(checks),
    allowedPathPatterns: parseLines(paths),
    requireHumanApproval: requireApproval,
  },
  requirePlanApproval: planApproval,
});
```

Import `parseLines` from `@/lib/parse-lines`.

- [ ] **Step 4: Thread the props at the call site**

In `apps/web/src/app/(app)/repos/[owner]/[repo]/page.tsx`, extend the existing `<SettingsTab …/>` (lines 155-161):

Note the existing local names: `page.tsx:37` destructures `const { owner, repo: repoName } = await params;` and `page.tsx:41` already builds `const repo = \`${owner}/${repoName}\`;`. So `repo` is **already** the `owner/name` string — use it directly for `getRepoPolicy`, and do not re-interpolate `owner` into it. `SettingsTab` takes no `repo` prop.

```tsx
<SettingsTab
  containerId={mission.id}
  concurrencyCap={mission.concurrencyCap}
  budgetUsd={mission.budgetUsd}
  aiReviewEnabled={mission.aiReviewEnabled}
  selfVerifyEnabled={mission.selfVerifyEnabled}
  autoMergePolicy={mission.autoMergePolicy as AutoMergePolicy | null}
  requirePlanApproval={repoPolicy.requirePlanApproval}
/>
```

Fetch `repoPolicy` in the page's server component with `const repoPolicy = await getRepoPolicy(repo);` from `@/lib/repo-policy`, which already returns the gated default when unset. Import `AutoMergePolicy` from `@forge/db`.

- [ ] **Step 5: Verify and commit**

Run: `cd /Users/paulmeller/Projects/agentstep/agentstep-forge && pnpm typecheck && pnpm -r lint && pnpm -r test`
Expected: all clean.

```bash
git add "apps/web/src/app/(app)/repos/[owner]/[repo]"
git commit -m "feat(settings): expose the gating policies in the repo Settings tab"
```

---

## Final verification

- [ ] `pnpm typecheck && pnpm -r lint && pnpm -r test` clean
- [ ] Enabling auto-merge on a container makes an existing leaf's `ready_to_merge` Task merge-eligible without recreating anything — the live-lookup property, proven by test not by inspection
- [ ] `missionTerminalStatusesFor` is still synchronous and still directly unit-testable
- [ ] Every mutation listed in Tasks 1-3 was actually run, with the mutated source printed to confirm the edit landed, and reported per behaviour rather than bundled
- [ ] No migration was generated; if one was, its filename appears in `packages/db/migrations/meta/_journal.json`
