# New Mission Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/missions/new` as a minimal composer (goal + mission type + target) with auto-resolved defaults, a repo picker, one collapsed Advanced section, and the AgentStep lime accent.

**Architecture:** Pure default-resolution helpers in a new lib file (unit-tested), thin DB wrappers in a sibling server-only file, and a reworked client form that submits the exact same field names the existing server action/zod schema already accept. The Advanced section stays mounted but `hidden`, so its named inputs always submit. Spec: `docs/superpowers/specs/2026-07-15-new-mission-composer-design.md`.

**Tech Stack:** Next.js 15 App Router, React 19, shadcn/radix, drizzle + libSQL, zod v4, vitest.

## Global Constraints

- No DB schema or migration changes. No changes to `createMissionSchema` in `apps/web/src/lib/missions.ts`.
- `targetRepos` is always submitted as newline/comma text — `parseRepoList` stays the contract.
- Creation never blocks on missing config: missing agent/GitHub IDs → amber nudge banner, mission still lands in `draft`.
- Lime accent ONLY on: Create button, selected mission-type card ring, checkboxes. Focus rings stay zinc (deliberate — avoids console-wide side effects).
- `font-title` (VVDSFifties) must always pair with `uppercase`.
- Copy strings below are exact — do not paraphrase.
- Mission-type radiogroup a11y attributes (`role="radiogroup"`, `role="radio"`, `aria-checked`, `aria-labelledby`) must survive the rework.
- Run all commands from the repo root `/Users/paulmeller/Projects/agentstep/agentstep-forge`.

---

### Task 1: Pure default helpers (`deriveMissionName`, `pickMissionDefaults`)

**Files:**
- Create: `apps/web/src/lib/mission-defaults.ts`
- Test: `apps/web/src/lib/mission-defaults.test.ts`

**Interfaces:**
- Produces:
  - `deriveMissionName(goal: string): string`
  - `type MissionDefaults = { agentId: string | null; githubInstallationId: string | null; githubVaultId: string | null; source: 'setup' | 'env' | 'none' }`
  - `type InstallationDefaults = { installationId: number; agentId: string | null; githubVaultId: string | null }`
  - `type EnvDefaults = { agentId: string | undefined; githubVaultId: string | undefined }`
  - `pickMissionDefaults(installation: InstallationDefaults | undefined, envDefaults: EnvDefaults): MissionDefaults`
- This file must have **zero server imports** (no db, no env) — client components type-import from it.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/mission-defaults.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { deriveMissionName, pickMissionDefaults } from './mission-defaults';

describe('deriveMissionName', () => {
  it('takes the first sentence of the goal', () => {
    expect(
      deriveMissionName('Bump fast-glob to ^3.3.2. Run the tests. Revert on failure.'),
    ).toBe('Bump fast-glob to ^3.3.2');
  });

  it('splits on newlines and question/exclamation marks too', () => {
    expect(deriveMissionName('Fix the login bug\nThen deploy')).toBe('Fix the login bug');
    expect(deriveMissionName('Why is CI red? Investigate.')).toBe('Why is CI red');
  });

  it('truncates to 80 characters', () => {
    const goal = 'a'.repeat(200);
    expect(deriveMissionName(goal)).toHaveLength(80);
  });

  it('skips leading blank lines', () => {
    expect(deriveMissionName('\n\n  Ship it\nrest')).toBe('Ship it');
  });

  it('falls back to Untitled Mission for empty or whitespace goals', () => {
    expect(deriveMissionName('')).toBe('Untitled Mission');
    expect(deriveMissionName('   \n  ')).toBe('Untitled Mission');
  });
});

describe('pickMissionDefaults', () => {
  const install = { installationId: 146708939, agentId: 'agent_setup', githubVaultId: 'vault_setup' };
  const envD = { agentId: 'agent_env', githubVaultId: 'vault_env' };
  const noEnv = { agentId: undefined, githubVaultId: undefined };

  it('prefers installation values and reports source setup', () => {
    expect(pickMissionDefaults(install, envD)).toEqual({
      agentId: 'agent_setup',
      githubInstallationId: '146708939',
      githubVaultId: 'vault_setup',
      source: 'setup',
    });
  });

  it('falls back to env when there is no installation', () => {
    expect(pickMissionDefaults(undefined, envD)).toEqual({
      agentId: 'agent_env',
      githubInstallationId: null,
      githubVaultId: 'vault_env',
      source: 'env',
    });
  });

  it('keeps the installation id but uses env agent when the installation has none', () => {
    const result = pickMissionDefaults({ ...install, agentId: null }, envD);
    expect(result.agentId).toBe('agent_env');
    expect(result.githubInstallationId).toBe('146708939');
    expect(result.source).toBe('env');
  });

  it('reports none when nothing resolves an agent', () => {
    expect(pickMissionDefaults(undefined, noEnv)).toEqual({
      agentId: null,
      githubInstallationId: null,
      githubVaultId: null,
      source: 'none',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @forge/web test -- mission-defaults`
Expected: FAIL — cannot resolve `./mission-defaults`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/mission-defaults.ts`:

```ts
/**
 * Pure helpers for the New Mission composer. This file must stay free of
 * server-only imports (db, env) — client components type-import from it.
 */

export type MissionDefaults = {
  agentId: string | null;
  githubInstallationId: string | null;
  githubVaultId: string | null;
  /** Where the agent id came from — drives the composer's transparency line. */
  source: 'setup' | 'env' | 'none';
};

export type InstallationDefaults = {
  installationId: number;
  agentId: string | null;
  githubVaultId: string | null;
};

export type EnvDefaults = {
  agentId: string | undefined;
  githubVaultId: string | undefined;
};

/** First sentence of the goal, ≤80 chars, fallback "Untitled Mission". */
export function deriveMissionName(goal: string): string {
  const firstSentence = goal
    .split(/[.!?\n]/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!firstSentence) return 'Untitled Mission';
  return firstSentence.slice(0, 80).trim() || 'Untitled Mission';
}

/** Setup installation wins, env fills gaps, source describes the agent id. */
export function pickMissionDefaults(
  installation: InstallationDefaults | undefined,
  envDefaults: EnvDefaults,
): MissionDefaults {
  const agentId = installation?.agentId ?? envDefaults.agentId ?? null;
  const githubVaultId = installation?.githubVaultId ?? envDefaults.githubVaultId ?? null;
  const githubInstallationId = installation ? String(installation.installationId) : null;
  const source: MissionDefaults['source'] = installation?.agentId
    ? 'setup'
    : agentId
      ? 'env'
      : 'none';
  return { agentId, githubInstallationId, githubVaultId, source };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @forge/web test -- mission-defaults`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/mission-defaults.ts apps/web/src/lib/mission-defaults.test.ts
git commit -m "feat(composer): pure mission-default helpers"
```

---

### Task 2: DB wrappers (`resolveMissionDefaults`, `listUserRepos`)

**Files:**
- Create: `apps/web/src/lib/mission-defaults-db.ts`

**Interfaces:**
- Consumes: `pickMissionDefaults`, types from Task 1.
- Produces (server-only; imported by `page.tsx`):
  - `resolveMissionDefaults(userId: string): Promise<MissionDefaults>`
  - `listUserRepos(userId: string): Promise<string[]>` — sorted `owner/repo` strings.

- [ ] **Step 1: Write the implementation**

Create `apps/web/src/lib/mission-defaults-db.ts`:

```ts
import { eq } from 'drizzle-orm';

import { githubInstallationRepos, githubInstallations } from '@forge/db';

import { db } from './db';
import { env } from './env';
import { pickMissionDefaults, type MissionDefaults } from './mission-defaults';

/** Resolve composer defaults: the user's Setup installation, then env. */
export async function resolveMissionDefaults(userId: string): Promise<MissionDefaults> {
  const [installation] = await db
    .select({
      installationId: githubInstallations.installationId,
      agentId: githubInstallations.agentId,
      githubVaultId: githubInstallations.githubVaultId,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.userId, userId))
    .limit(1);

  return pickMissionDefaults(installation, {
    agentId: env.FORGE_DEFAULT_AGENT_ID,
    githubVaultId: env.FORGE_DEFAULT_GITHUB_VAULT_ID,
  });
}

/** Repos the user's GitHub App installation can reach, for the repo picker. */
export async function listUserRepos(userId: string): Promise<string[]> {
  const rows = await db
    .select({ repo: githubInstallationRepos.repo })
    .from(githubInstallationRepos)
    .innerJoin(
      githubInstallations,
      eq(githubInstallationRepos.installationId, githubInstallations.id),
    )
    .where(eq(githubInstallations.userId, userId));

  return rows.map((r) => r.repo).sort();
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean exit, no output after the script banner.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/mission-defaults-db.ts
git commit -m "feat(composer): resolve defaults and repo list from Setup + env"
```

---

### Task 3: Accent tokens + Button `accent` variant

**Files:**
- Modify: `apps/web/src/app/globals.css` (the `:root` and `.dark` blocks, ~lines 20–64)
- Modify: `apps/web/src/components/ui/button.tsx` (the `variant` map)

**Interfaces:**
- Produces: CSS vars `--forge-accent-from`, `--forge-accent-to`, `--forge-accent-ink`; `<Button variant="accent">`; utility class `accent-checkbox`.

- [ ] **Step 1: Add tokens to globals.css**

In `apps/web/src/app/globals.css`, inside the existing `:root { ... }` block (after the `--text-gradient` line), add:

```css
    /* Console interaction accent — same lime family as --text-gradient. */
    --forge-accent-from: oklch(0.93 0.26 110);
    --forge-accent-to: oklch(0.9 0.29 132);
    --forge-accent-ink: oklch(0.25 0.06 130);
```

Inside the existing `.dark { ... }` block, add the same three lines (identical values — lime reads on both grounds).

At the end of the file, add:

```css
@layer utilities {
  .accent-checkbox {
    accent-color: var(--forge-accent-to);
  }
}
```

- [ ] **Step 2: Add the Button variant**

In `apps/web/src/components/ui/button.tsx`, add one line to the `variant` object (after `default`):

```ts
        accent:
          "bg-[linear-gradient(135deg,var(--forge-accent-from),var(--forge-accent-to))] text-[color:var(--forge-accent-ink)] shadow hover:opacity-90",
```

- [ ] **Step 3: Typecheck and verify dev server compiles**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/missions/new`
Expected: `200` (or `307` after Task 7 adds auth — at this task, `200`).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/globals.css apps/web/src/components/ui/button.tsx
git commit -m "feat(composer): lime accent tokens and Button accent variant"
```

---

### Task 4: Derive the mission name in the server action

**Files:**
- Modify: `apps/web/src/app/(app)/missions/new/actions.ts`

**Interfaces:**
- Consumes: `deriveMissionName` from Task 1.
- Produces: `createMissionAction` accepts a blank/absent `name` field and derives one from `goal`. Everything else unchanged.

- [ ] **Step 1: Edit the action**

In `apps/web/src/app/(app)/missions/new/actions.ts`, add the import:

```ts
import { deriveMissionName } from '@/lib/mission-defaults';
```

Then replace the two lines building `name` and `goal` in the `raw` object:

```ts
    name: formData.get('name'),
    goal: formData.get('goal'),
```

with:

```ts
    name:
      toNullableString(formData.get('name')) ??
      deriveMissionName(typeof goalRaw === 'string' ? goalRaw : ''),
    goal: formData.get('goal'),
```

and add `const goalRaw = formData.get('goal');` on the line right after the existing `const targetReposRaw = formData.get('targetRepos');`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean. (Behavior is covered by Task 1's unit tests plus Task 8's end-to-end check.)

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/missions/new/actions.ts"
git commit -m "feat(composer): derive mission name from goal when blank"
```

---

### Task 5: RepoPicker component

**Files:**
- Create: `apps/web/src/app/(app)/missions/new/repo-picker.tsx`

**Interfaces:**
- Produces: `<RepoPicker mode={'single' | 'multi'} availableRepos={string[]} error={string | undefined} />`
  - Always submits the form field `targetRepos` (hidden input when picking from a list, visible input/textarea in free-text fallback).
  - Selection state survives switching `mode` (fleet ↔ single keeps the first selection).

- [ ] **Step 1: Write the component**

Create `apps/web/src/app/(app)/missions/new/repo-picker.tsx`:

```tsx
'use client';

import { useState } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/**
 * Target-repo input for the composer. With an installation repo list it's a
 * picker (single Select or multi checkboxes); without one it degrades to the
 * free-text inputs. Either way the form receives `targetRepos` as text, so
 * the server contract (parseRepoList) is unchanged.
 */
export function RepoPicker({
  mode,
  availableRepos,
  error,
}: {
  mode: 'single' | 'multi';
  availableRepos: string[];
  error?: string;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const hasList = availableRepos.length > 0;

  const label = mode === 'multi' ? 'Target repositories' : 'Target repository';
  const submittedValue = mode === 'multi' ? selected.join('\n') : (selected[0] ?? '');

  function toggle(repo: string) {
    setSelected((prev) =>
      prev.includes(repo) ? prev.filter((r) => r !== repo) : [...prev, repo],
    );
  }

  return (
    <div>
      <Label htmlFor="targetRepos">{label}</Label>
      {hasList ? (
        <>
          {mode === 'single' ? (
            <Select
              value={selected[0] ?? ''}
              onValueChange={(v) => setSelected([v])}
            >
              <SelectTrigger id="targetRepos" className="font-mono text-sm">
                <SelectValue placeholder="Pick a repo" />
              </SelectTrigger>
              <SelectContent>
                {availableRepos.map((repo) => (
                  <SelectItem key={repo} value={repo} className="font-mono text-sm">
                    {repo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="mt-1 max-h-48 overflow-y-auto rounded-md border">
              {availableRepos.map((repo) => (
                <label
                  key={repo}
                  className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 font-mono text-sm last:border-b-0 hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    className="accent-checkbox h-4 w-4"
                    checked={selected.includes(repo)}
                    onChange={() => toggle(repo)}
                  />
                  {repo}
                </label>
              ))}
            </div>
          )}
          <input type="hidden" name="targetRepos" value={submittedValue} />
          <p className="mt-1 text-xs text-muted-foreground">
            {mode === 'multi'
              ? `${selected.length} selected — from your GitHub App installation.`
              : 'From your GitHub App installation.'}
          </p>
        </>
      ) : (
        <>
          {mode === 'single' ? (
            <Input
              id="targetRepos"
              name="targetRepos"
              placeholder="acme/api"
              className="font-mono text-sm"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
            />
          ) : (
            <Textarea
              id="targetRepos"
              name="targetRepos"
              rows={6}
              placeholder="acme/api&#10;acme/web&#10;acme/mobile"
              className="font-mono text-sm"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
            />
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {mode === 'multi' ? (
              <>
                One <span className="font-mono">owner/repo</span> per line. Commas or whitespace
                also work.
              </>
            ) : (
              'The Planner emits one Task against this repo.'
            )}
          </p>
        </>
      )}
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/missions/new/repo-picker.tsx"
git commit -m "feat(composer): RepoPicker with installation list and free-text fallback"
```

---

### Task 6: AdvancedSettings component

**Files:**
- Create: `apps/web/src/app/(app)/missions/new/advanced-settings.tsx`

**Interfaces:**
- Consumes: `type MissionDefaults` (type-only import from `@/lib/mission-defaults`).
- Produces:
  ```ts
  <AdvancedSettings
    open={boolean}
    skills={SkillOption[]}          // { id, name, slug, description }
    defaults={MissionDefaults}
    missionType={'fleet' | 'single' | 'triage'}
    decompStrategy={string}
    onDecompChange={(v: string) => void}
    fieldErrors={Record<string, string> | undefined}
  />
  ```
  - Renders a `<div id="advanced-panel" hidden={!open}>` that stays **mounted** so its named inputs (`name`, `skillId`, `backend`, `agentId`, `concurrencyCap`, `aiReviewEnabled`, `selfVerifyEnabled`, budget + hard-stop fields, `githubInstallationId`, `githubVaultId`) always submit with the form.
  - The Decomposition Select has **no `name`** — the parent form submits `plannerStrategy` via one hidden input.
  - Must be rendered inside the parent `<form>`.

- [ ] **Step 1: Write the component**

Create `apps/web/src/app/(app)/missions/new/advanced-settings.tsx`:

```tsx
'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MissionDefaults } from '@/lib/mission-defaults';

export type SkillOption = { id: string; name: string; slug: string; description: string | null };

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

function FieldError({
  errors,
  name,
}: {
  errors: Record<string, string> | undefined;
  name: string;
}) {
  if (!errors?.[name]) return null;
  return <p className="mt-1 text-xs text-destructive">{errors[name]}</p>;
}

/**
 * Collapsed-by-default power settings. Stays mounted (`hidden` attr) so every
 * named field submits even while collapsed — collapsing hides, never unsets.
 */
export function AdvancedSettings({
  open,
  skills,
  defaults,
  missionType,
  decompStrategy,
  onDecompChange,
  fieldErrors,
}: {
  open: boolean;
  skills: SkillOption[];
  defaults: MissionDefaults;
  missionType: 'fleet' | 'single' | 'triage';
  decompStrategy: string;
  onDecompChange: (v: string) => void;
  fieldErrors: Record<string, string> | undefined;
}) {
  return (
    <div
      id="advanced-panel"
      hidden={!open}
      className="space-y-6 rounded-xl border bg-card p-6 text-card-foreground shadow"
    >
      <div className="space-y-4">
        <GroupLabel>Mission</GroupLabel>
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" placeholder="Auto-generated from goal" maxLength={200} />
          <FieldError errors={fieldErrors} name="name" />
        </div>
        {skills.length > 0 ? (
          <div>
            <Label htmlFor="skillId">Skill</Label>
            <Select name="skillId">
              <SelectTrigger id="skillId">
                <SelectValue placeholder="No skill (freestyle)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No skill (freestyle)</SelectItem>
                {skills.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                    {s.description ? ` — ${s.description.slice(0, 60)}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      <div className="space-y-4">
        <GroupLabel>Execution</GroupLabel>
        <div>
          <Label htmlFor="backend">Backend</Label>
          <Select name="backend" defaultValue="managed-agents" required>
            <SelectTrigger id="backend">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="managed-agents">Anthropic Managed Agents</SelectItem>
              <SelectItem value="gateway">AgentStep Gateway</SelectItem>
            </SelectContent>
          </Select>
          <FieldError errors={fieldErrors} name="backend" />
        </div>
        <div>
          <Label htmlFor="agentId">Agent ID</Label>
          <Input
            id="agentId"
            name="agentId"
            placeholder="agent_abc123..."
            maxLength={200}
            defaultValue={defaults.agentId ?? ''}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {defaults.source === 'setup'
              ? 'Resolved from your Setup installation.'
              : defaults.source === 'env'
                ? 'Resolved from the env default.'
                : 'Create the agent out-of-band (Anthropic CLI or console) and paste its ID here.'}
          </p>
          <FieldError errors={fieldErrors} name="agentId" />
        </div>
        {missionType !== 'triage' ? (
          <div>
            <Label htmlFor="decompStrategy">Decomposition strategy</Label>
            <Select value={decompStrategy} onValueChange={onDecompChange}>
              <SelectTrigger id="decompStrategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rule-based">
                  {missionType === 'fleet'
                    ? 'Rule-based — one Task per repo'
                    : 'Rule-based — single Task'}
                </SelectItem>
                <SelectItem value="llm">LLM — decomposes goal into dependent tasks</SelectItem>
                <SelectItem value="graph" disabled>
                  Graph / DAG — coming soon
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div>
          <Label htmlFor="concurrencyCap">Concurrency cap</Label>
          <Input
            id="concurrencyCap"
            name="concurrencyCap"
            type="number"
            min={1}
            max={100}
            defaultValue={5}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Max Tasks in flight at once for this Mission.
          </p>
          <FieldError errors={fieldErrors} name="concurrencyCap" />
        </div>
      </div>

      <div className="space-y-4">
        <GroupLabel>Gates</GroupLabel>
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="aiReviewEnabled"
            name="aiReviewEnabled"
            className="accent-checkbox h-4 w-4 rounded border-input"
          />
          <div>
            <Label htmlFor="aiReviewEnabled">AI code review before merge</Label>
            <p className="text-xs text-muted-foreground">
              AI reviews each PR against the mission goal before auto-merge.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="selfVerifyEnabled"
            name="selfVerifyEnabled"
            className="accent-checkbox h-4 w-4 rounded border-input"
          />
          <div>
            <Label htmlFor="selfVerifyEnabled">Self-verification gate</Label>
            <p className="text-xs text-muted-foreground">
              A checker model confirms each PR meets its skill&apos;s acceptance criteria before
              review (a /goal-style done-check). Requires a skill with criteria.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <GroupLabel>Budget</GroupLabel>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="budgetUsd">Budget (USD)</Label>
            <Input id="budgetUsd" name="budgetUsd" type="number" min={1} placeholder="200" />
          </div>
          <div>
            <Label htmlFor="budgetTokens">Budget (tokens)</Label>
            <Input
              id="budgetTokens"
              name="budgetTokens"
              type="number"
              min={1}
              placeholder="1000000"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="budgetThresholdPct">Soft-pause threshold (%)</Label>
            <Input
              id="budgetThresholdPct"
              name="budgetThresholdPct"
              type="number"
              min={1}
              max={100}
              defaultValue={80}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Mission pauses; in-flight Tasks finish.
            </p>
          </div>
          <div>
            <Label htmlFor="budgetHardStopPct">Hard-stop ceiling (%)</Label>
            <Input
              id="budgetHardStopPct"
              name="budgetHardStopPct"
              type="number"
              min={1}
              max={500}
              defaultValue={100}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Cancels the Mission and kills in-flight sessions.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <GroupLabel>Per-task hard stops</GroupLabel>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <Label htmlFor="taskMaxTurns">Max turns</Label>
            <Input id="taskMaxTurns" name="taskMaxTurns" type="number" min={1} placeholder="30" />
          </div>
          <div>
            <Label htmlFor="taskMaxTokens">Max tokens</Label>
            <Input
              id="taskMaxTokens"
              name="taskMaxTokens"
              type="number"
              min={1}
              placeholder="unbounded"
            />
          </div>
          <div>
            <Label htmlFor="noProgressTokens">No-progress tokens</Label>
            <Input
              id="noProgressTokens"
              name="noProgressTokens"
              type="number"
              min={1}
              placeholder="200000"
            />
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <GroupLabel>GitHub</GroupLabel>
        <div>
          <Label htmlFor="githubInstallationId">GitHub App installation ID (repo clone)</Label>
          <Input
            id="githubInstallationId"
            name="githubInstallationId"
            placeholder="12345678"
            defaultValue={defaults.githubInstallationId ?? ''}
          />
        </div>
        <div>
          <Label htmlFor="githubVaultId">GitHub MCP vault ID (PR creation)</Label>
          <Input
            id="githubVaultId"
            name="githubVaultId"
            placeholder="vlt_..."
            defaultValue={defaults.githubVaultId ?? ''}
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/missions/new/advanced-settings.tsx"
git commit -m "feat(composer): always-mounted AdvancedSettings disclosure"
```

---

### Task 7: Composer rework — form + page

**Files:**
- Modify: `apps/web/src/app/(app)/missions/new/new-mission-form.tsx` (full rewrite)
- Modify: `apps/web/src/app/(app)/missions/new/page.tsx` (full rewrite)

**Interfaces:**
- Consumes: `RepoPicker` (Task 5), `AdvancedSettings` + `SkillOption` (Task 6), `resolveMissionDefaults`/`listUserRepos` (Task 2), `MissionDefaults` type (Task 1), `Button variant="accent"` (Task 3).
- Produces: the new composer page. Submitted field names are identical to today's contract: `goal`, `plannerStrategy` (single hidden input), `targetRepos`, `issueQuery`, plus everything AdvancedSettings carries.

- [ ] **Step 1: Rewrite the form**

Replace the entire contents of `apps/web/src/app/(app)/missions/new/new-mission-form.tsx` with:

```tsx
'use client';

import { useActionState, useState } from 'react';
import { Bug, Check, GitBranch, LayoutGrid } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { MissionDefaults } from '@/lib/mission-defaults';
import { cn } from '@/lib/utils';

import { AdvancedSettings, type SkillOption } from './advanced-settings';
import { createMissionAction, type CreateMissionState } from './actions';
import { RepoPicker } from './repo-picker';

const initialState: CreateMissionState = {};

const MISSION_TYPES = [
  {
    value: 'fleet',
    label: 'Fleet',
    description: 'Goal → Tasks across a list of repos. Each Task opens a PR, gated on CI.',
    icon: LayoutGrid,
  },
  {
    value: 'single',
    label: 'Single repo',
    description: 'Goal → Tasks against one repo. Opens a PR, gated on CI.',
    icon: GitBranch,
  },
  {
    value: 'triage',
    label: 'Bug triage',
    description:
      'Issue query → a reproduce → fix pair per matching issue. Fixes dispatch only once a bug is confirmed.',
    icon: Bug,
  },
] as const;

export function NewMissionForm({
  availableSkills = [],
  availableRepos = [],
  defaults,
}: {
  availableSkills?: SkillOption[];
  availableRepos?: string[];
  defaults: MissionDefaults;
}) {
  const [state, formAction, pending] = useActionState(createMissionAction, initialState);
  const [missionType, setMissionType] = useState<'fleet' | 'single' | 'triage'>('single');
  const [decompStrategy, setDecompStrategy] = useState('rule-based');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isTriage = missionType === 'triage';
  const plannerStrategy = isTriage ? 'triage' : decompStrategy;

  const needsSetup = !defaults.agentId || !defaults.githubInstallationId;
  const agentNote =
    defaults.source === 'setup'
      ? 'agent from Setup'
      : defaults.source === 'env'
        ? 'agent from env default'
        : 'no agent — connect in Setup';

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="plannerStrategy" value={plannerStrategy} />

      <div>
        <Label htmlFor="goal">Goal</Label>
        <Textarea
          id="goal"
          name="goal"
          rows={5}
          className="mt-1 text-base"
          placeholder="Update the `fast-glob` dependency to ^3.3.2 everywhere it appears in package.json. Run the tests. If the tests fail, revert."
          required
          maxLength={10_000}
        />
        <FieldError errors={state.fieldErrors} name="goal" />
        <FieldError errors={state.fieldErrors} name="name" />
      </div>

      <div>
        <Label id="mission-type-label">Mission type</Label>
        <div
          role="radiogroup"
          aria-labelledby="mission-type-label"
          className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3"
        >
          {MISSION_TYPES.map((option) => {
            const Icon = option.icon;
            const selected = missionType === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setMissionType(option.value)}
                className={cn(
                  'relative rounded-lg border p-3 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  selected
                    ? 'border-transparent ring-2 ring-[color:var(--forge-accent-to)]'
                    : 'border-input hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {selected ? (
                  <span className="absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full bg-[color:var(--forge-accent-to)]">
                    <Check className="h-2.5 w-2.5 text-[color:var(--forge-accent-ink)]" />
                  </span>
                ) : null}
                <Icon className="h-4 w-4 text-muted-foreground" />
                <p className="mt-2 text-sm font-medium">{option.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{option.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      {isTriage ? (
        <div>
          <Label htmlFor="issueQuery">Issue search query</Label>
          <Input
            id="issueQuery"
            name="issueQuery"
            placeholder="repo:vercel/ai is:issue is:open label:bug"
            maxLength={500}
            className="font-mono text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            A GitHub issue search. Each matching issue becomes a gated{' '}
            <span className="font-mono">reproduce → fix</span> Task pair.
          </p>
          <FieldError errors={state.fieldErrors} name="issueQuery" />
        </div>
      ) : (
        <RepoPicker
          mode={missionType === 'fleet' ? 'multi' : 'single'}
          availableRepos={availableRepos}
          error={state.fieldErrors?.targetRepos}
        />
      )}

      {needsSetup ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          Missions can be planned now, but connect GitHub in{' '}
          <Link href="/setup" className="underline underline-offset-2">
            Setup
          </Link>{' '}
          before dispatching.
        </div>
      ) : null}

      {state.error ? (
        <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {state.error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {agentNote} · plan reviewed before dispatch ·{' '}
          <button
            type="button"
            aria-expanded={showAdvanced}
            aria-controls="advanced-panel"
            onClick={() => setShowAdvanced((v) => !v)}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Advanced settings
          </button>
        </p>
        <Button type="submit" variant="accent" disabled={pending}>
          {pending ? 'Creating…' : 'Create Mission'}
        </Button>
      </div>

      <AdvancedSettings
        open={showAdvanced}
        skills={availableSkills}
        defaults={defaults}
        missionType={missionType}
        decompStrategy={decompStrategy}
        onDecompChange={setDecompStrategy}
        fieldErrors={state.fieldErrors}
      />
    </form>
  );
}

function FieldError({
  errors,
  name,
}: {
  errors: Record<string, string> | undefined;
  name: string;
}) {
  if (!errors?.[name]) return null;
  return <p className="mt-1 text-xs text-destructive">{errors[name]}</p>;
}
```

- [ ] **Step 2: Rewrite the page**

Replace the entire contents of `apps/web/src/app/(app)/missions/new/page.tsx` with:

```tsx
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { resolveMissionDefaults, listUserRepos } from '@/lib/mission-defaults-db';
import { listSkills } from '@/lib/skills';
import { withAuth } from '@/lib/with-auth';

import { NewMissionForm } from './new-mission-form';

export const dynamic = 'force-dynamic';

export default async function NewMissionPage() {
  const user = await withAuth();
  const [skills, defaults, availableRepos] = await Promise.all([
    listSkills(),
    resolveMissionDefaults(user.id),
    listUserRepos(user.id),
  ]);

  return (
    <main className="container max-w-3xl py-10">
      <div className="mb-8">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4">
          <Link href="/missions">&larr; Back to missions</Link>
        </Button>
        <h1 className="font-title text-3xl uppercase tracking-tight">New Mission</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe the work. Forge plans it into Tasks you review before anything dispatches.
        </p>
      </div>
      <NewMissionForm
        availableSkills={skills.map((s) => ({
          id: s.id,
          name: s.name,
          slug: s.slug,
          description: s.description,
        }))}
        availableRepos={availableRepos}
        defaults={defaults}
      />
    </main>
  );
}
```

- [ ] **Step 3: Typecheck and check the dev server**

Run: `pnpm --filter @forge/web typecheck`
Expected: clean.
Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/missions/new`
Expected: `307` (page now requires auth; a 500 means a compile/runtime error — check the dev-server log).

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/missions/new/new-mission-form.tsx" "apps/web/src/app/(app)/missions/new/page.tsx"
git commit -m "feat(composer): rebuild /missions/new as goal-first composer"
```

---

### Task 8: Full verification

**Files:** none (verification only)

> Note: the spec's "render test" (Advanced absent from the a11y tree until
> expanded; radiogroup semantics) is covered here by manual checks #2–#3 —
> the repo has no component-test infra (no @testing-library/jsdom), and
> adding it is out of scope for this plan.

- [ ] **Step 1: Run the whole web test suite**

Run: `pnpm --filter @forge/web test`
Expected: all suites pass, including `mission-defaults.test.ts`.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: clean across all workspace packages.

- [ ] **Step 3: Manual browser verification (requires the signed-in operator)**

Ask the operator to open http://localhost:3100/missions/new and confirm:

1. Title renders in the display face (uppercase VVDSFifties), subline reads "Describe the work. Forge plans it into Tasks you review before anything dispatches."
2. Above the fold: Goal textarea, three mission-type cards (Single selected, lime ring + badge), repo picker (their installation's repos listed), lime Create button, transparency line reading "agent from Setup · plan reviewed before dispatch · Advanced settings".
3. "Advanced settings" toggles the panel; collapsing it and submitting still creates a mission (fields submit while hidden).
4. Create a mission with only a goal + repo → lands on `/missions/<id>` in draft, name derived from the goal's first sentence, agent ID populated.
5. Switch to Fleet → repo list becomes checkboxes; to Bug triage → issue-query input appears.

- [ ] **Step 4: Report**

Summarize verification results (pass/fail per check) to the operator. Do not mark this task complete if any check fails.
