# AI SDK Structured-Output Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-rolled JSON parsing in `ai-review.ts`, `verify.ts`, and `llm-planner.ts` with the Vercel AI SDK's `generateObject`, bundled with an `ai` v6→v7 package upgrade.

**Architecture:** Each of the three files gets a small new exported function (`requestReview`, `requestVerdict`, `requestPlan`) that wraps a single `generateObject` call + zod schema + `NoObjectGeneratedError` fallback, replacing the old `parseXxx()` + raw-`@anthropic-ai/sdk`-call pair. Everything else in each file (DB writes, GitHub calls, retry logic) is unchanged — these functions only replace the "ask the model, get structured output back" step.

**Tech Stack:** `ai` v7, `@ai-sdk/anthropic` v4, zod v4 (already installed, no change), vitest.

## Global Constraints

- The v7 `system:` → `instructions:` rename applies to **every** `ai` package call that takes a system prompt — `generateText`/`streamText`/`generateObject`/`streamObject` alike, not just `streamText`. Task 4's `requestPlan` uses `instructions:`, not `system:`, for exactly this reason.
- All type shapes in this plan (`LanguageModelUsage.inputTokens`/`outputTokens`, `NoObjectGeneratedError`'s `.text`/`.usage`/`.finishReason`/`.isInstance()`, `GenerateObjectResult`'s `.object`/`.usage`) were read directly from the installed package's `.d.ts` files, not assumed — confirmed stable across the v6→v7 boundary per Vercel's migration guide (only the `inputTokenDetails`/`outputTokenDetails` *sub*-fields were restructured, not the base `inputTokens`/`outputTokens` names).
- `llm-planner.ts`'s migration must preserve its current external behavior exactly: a malformed model response re-throws the same `Error('LLM planner: failed to parse Claude response as JSON: ...')` message shape it does today. Do not let `generateObject`'s internal retry silently change this into invisible retry behavior.
- `ai-review.ts`/`verify.ts` must preserve their existing safe-default fallback shape (`{decision:'reject', ...}` / `{verdict:'incomplete', ...}`) on malformed output — "never silently pass" is a documented invariant in `verify.ts`'s own comments, not incidental behavior.
- Every task ends with `pnpm typecheck` and `pnpm test` green across the whole workspace.

---

### Task 1: Bump `ai`/`@ai-sdk/*` to the v7 line, fix chat route renames

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/app/(app)/api/chat/route.ts:6,55,57`

**Interfaces:**
- Produces: `ai@^7.0.31`, `@ai-sdk/anthropic@^4.0.16` (and the matching v7-line versions of `@ai-sdk/google`/`@ai-sdk/openai`/`@ai-sdk/react`) installed and building. Tasks 2-4 depend on `generateObject`/`NoObjectGeneratedError` being importable from `'ai'` and `anthropic` from `'@ai-sdk/anthropic'` at these versions.

- [ ] **Step 1: Bump the packages**

```bash
cd apps/web
pnpm add ai@^7.0.31 @ai-sdk/anthropic@^4.0.16
pnpm add @ai-sdk/google@latest @ai-sdk/openai@latest @ai-sdk/react@latest
```

- [ ] **Step 2: Fix the two renames in the chat route**

In `apps/web/src/app/(app)/api/chat/route.ts`, change line 6:

```typescript
import { convertToModelMessages, isStepCount, streamText } from 'ai';
```

And change the `streamText` call (originally lines 53-58):

```typescript
  const result = streamText({
    model: getChatModel(),
    instructions: SYSTEM_PROMPT,
    messages: await convertToModelMessages(uiMessages),
    stopWhen: isStepCount(5),
    tools: {
```

(Only `system:` → `instructions:` and `stepCountIs` → `isStepCount` change — the rest of the `streamText` call, and everything else in the file, is untouched.)

- [ ] **Step 3: Confirm no other file references the renamed symbols**

```bash
grep -rn "stepCountIs" apps/web/src --include="*.ts" --include="*.tsx"
```

Expected: no output (the chat route was the only call site).

- [ ] **Step 4: Typecheck and run the existing suite**

```bash
pnpm typecheck
pnpm test
```

Expected: both green. This confirms the rename compiles; it does not exercise the chat route at runtime (no test file exists for it).

- [ ] **Step 5: Manual smoke test of the chat route**

Start the dev server (`pnpm --filter @forge/web dev`), open the console's chat UI, send a message that doesn't trigger a tool call (e.g. "hello") and confirm you get a streamed response with no errors in the server log or browser console. Then send one that triggers `list_repos` or `list_missions` and confirm the tool call still executes and its result is reflected in the reply. Stop the dev server afterward.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/app/\(app\)/api/chat/route.ts
git commit -m "chore(web): upgrade ai SDK to v7 line, fix stepCountIs/system renames"
```

---

### Task 2: Migrate `ai-review.ts` to `generateObject`

**Files:**
- Modify: `apps/web/src/server/tick/ai-review.ts`
- Modify: `apps/web/src/server/tick/ai-review.test.ts`

**Interfaces:**
- Consumes: `generateObject`, `NoObjectGeneratedError` from `'ai'`; `anthropic` from `'@ai-sdk/anthropic'` (Task 1).
- Produces: `export async function requestReview(opts: { goal: string; diff: string; summary: string }): Promise<{ review: ParsedReview; tokensUsed: number }>` — the only new export. `ParsedReview`/`ReviewDecision` types are unchanged. `reviewOne` (private, unexported) now calls `requestReview` instead of the old inline block.

- [ ] **Step 1: Write the failing tests** — add to the bottom of `apps/web/src/server/tick/ai-review.test.ts` (keep the existing `buildReviewPrompt` describe block; the `parseReviewResponse` describe block will be deleted in Step 3):

```typescript
import { NoObjectGeneratedError } from 'ai';
import { beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateObject: mocks.generateObject };
});

describe('requestReview', () => {
  beforeEach(() => {
    mocks.generateObject.mockReset();
  });

  it('returns the schema-shaped review and token usage on success', async () => {
    mocks.generateObject.mockResolvedValueOnce({
      object: { decision: 'approve', feedback: 'looks good' },
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const { requestReview } = await import('./ai-review');
    const { review, tokensUsed } = await requestReview({
      goal: 'bump lodash',
      diff: '+foo',
      summary: '',
    });

    expect(review).toEqual({ decision: 'approve', feedback: 'looks good' });
    expect(tokensUsed).toBe(120);
  });

  it('falls back to a safe reject when the model returns an unparseable object', async () => {
    mocks.generateObject.mockRejectedValueOnce(
      new NoObjectGeneratedError({
        text: 'not valid json',
        response: {} as never,
        usage: { inputTokens: 50, outputTokens: 5 } as never,
        finishReason: 'stop',
      }),
    );

    const { requestReview } = await import('./ai-review');
    const { review, tokensUsed } = await requestReview({
      goal: 'bump lodash',
      diff: '+foo',
      summary: '',
    });

    expect(review.decision).toBe('reject');
    expect(review.feedback).toContain('unparseable response from AI reviewer');
    expect(review.feedback).toContain('not valid json');
    expect(tokensUsed).toBe(55);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @forge/web exec vitest run src/server/tick/ai-review.test.ts`
Expected: FAIL — `requestReview` is not exported from `./ai-review` yet.

- [ ] **Step 3: Implement `requestReview`, delete the old parser and call site**

In `apps/web/src/server/tick/ai-review.ts`:

Replace the import block (lines 1-11) with:

```typescript
import { randomUUID } from 'node:crypto';

import { anthropic } from '@ai-sdk/anthropic';
import { Octokit } from '@octokit/rest';
import { and, eq, isNotNull } from 'drizzle-orm';
import { generateObject, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';

import { ledgerEvents, missions, tasks, type Task } from '@forge/db';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
```

Delete the `aiClient()` singleton (originally lines 46-53) — `import Anthropic from '@anthropic-ai/sdk'` and the singleton are both gone; `anthropic` is now the imported provider function.

In `buildReviewPrompt()`, delete the trailing instructions paragraph (originally lines 90-97, the `## Instructions` section) — the function now ends right after the `## Review Criteria` list's last line (`4. **Pragmatic on style** — don't reject for minor style nits; only flag real problems`) plus the closing backtick.

Delete `parseReviewResponse()` (originally lines 100-118) entirely, and add `requestReview` in its place:

```typescript
const ReviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  feedback: z.string(),
});

/**
 * Ask the model to review a diff against a mission goal. Never throws for a
 * malformed model response — falls back to a safe reject, matching the
 * "never silently pass" invariant the old text-parsing path had.
 */
export async function requestReview(opts: {
  goal: string;
  diff: string;
  summary: string;
}): Promise<{ review: ParsedReview; tokensUsed: number }> {
  const prompt = buildReviewPrompt(opts);
  try {
    const { object, usage } = await generateObject({
      model: anthropic('claude-sonnet-4-6'),
      schema: ReviewSchema,
      prompt,
    });
    return {
      review: object,
      tokensUsed: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    };
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      return {
        review: {
          decision: 'reject',
          feedback: `unparseable response from AI reviewer: ${(error.text ?? '').slice(0, 200)}`,
        },
        tokensUsed: (error.usage?.inputTokens ?? 0) + (error.usage?.outputTokens ?? 0),
      };
    }
    throw error;
  }
}
```

In `reviewOne()`, replace the "3. Call Claude directly" / "4. Parse the response" block (originally lines 188-203):

```typescript
  // 3. Ask the model to review the diff.
  const { review, tokensUsed } = await requestReview({ goal: mission.goal, diff, summary: '' });
```

And update the token-cost line immediately after (originally line 206, now redundant since `requestReview` already returns `tokensUsed`):

```typescript
  const newCostTokens = task.costTokens + tokensUsed;
```

(Delete the old `const tokensUsed = (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);` line — `tokensUsed` now comes from `requestReview`'s return value.)

- [ ] **Step 4: Delete the now-obsolete `parseReviewResponse` tests**

In `apps/web/src/server/tick/ai-review.test.ts`, delete the entire `describe('parseReviewResponse', ...)` block (the function it tests no longer exists). Keep the `describe('buildReviewPrompt', ...)` block and the new `describe('requestReview', ...)` block from Step 1.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @forge/web exec vitest run src/server/tick/ai-review.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 6: Run the whole-workspace checks**

```bash
pnpm typecheck
pnpm test
```

Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/tick/ai-review.ts apps/web/src/server/tick/ai-review.test.ts
git commit -m "refactor(tick): migrate ai-review.ts to generateObject"
```

---

### Task 3: Migrate `verify.ts` to `generateObject`

**Files:**
- Modify: `apps/web/src/server/tick/verify.ts`
- Modify: `apps/web/src/server/tick/verify.test.ts`

**Interfaces:**
- Consumes: same as Task 2 (`generateObject`, `NoObjectGeneratedError` from `'ai'`; `anthropic` from `'@ai-sdk/anthropic'`).
- Produces: `export async function requestVerdict(opts: { acceptanceCriteria: string; diff: string; model: string }): Promise<{ verdict: Verdict; tokensUsed: number }>`. `Verdict` type is unchanged. `verifyOne` now calls `requestVerdict` instead of the old inline block; the dynamic `verifyModel` selection logic (env default + per-skill override) is unchanged and just gets passed in as `opts.model`.

- [ ] **Step 1: Write the failing tests** — add to the bottom of `apps/web/src/server/tick/verify.test.ts` (keep the existing `buildVerifyPrompt`/`buildVerifyFeedback` describe blocks; the `parseVerdict` describe block will be deleted in Step 3):

```typescript
import { NoObjectGeneratedError } from 'ai';
import { beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateObject: mocks.generateObject };
});

describe('requestVerdict', () => {
  beforeEach(() => {
    mocks.generateObject.mockReset();
  });

  it('returns the schema-shaped verdict and token usage on success', async () => {
    mocks.generateObject.mockResolvedValueOnce({
      object: { verdict: 'done' },
      usage: { inputTokens: 200, outputTokens: 10 },
    });

    const { requestVerdict } = await import('./verify');
    const { verdict, tokensUsed } = await requestVerdict({
      acceptanceCriteria: '- a PR is open',
      diff: 'diff --git a b',
      model: 'claude-haiku-4-5',
    });

    expect(verdict).toEqual({ verdict: 'done' });
    expect(tokensUsed).toBe(210);
  });

  it('falls back to incomplete when the model returns an unparseable object', async () => {
    mocks.generateObject.mockRejectedValueOnce(
      new NoObjectGeneratedError({
        text: 'garbage',
        response: {} as never,
        usage: { inputTokens: 30, outputTokens: 5 } as never,
        finishReason: 'stop',
      }),
    );

    const { requestVerdict } = await import('./verify');
    const { verdict, tokensUsed } = await requestVerdict({
      acceptanceCriteria: '- a PR is open',
      diff: 'diff --git a b',
      model: 'claude-haiku-4-5',
    });

    expect(verdict.verdict).toBe('incomplete');
    expect(verdict.missing).toContain('unparseable verifier response');
    expect(verdict.missing).toContain('garbage');
    expect(tokensUsed).toBe(35);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @forge/web exec vitest run src/server/tick/verify.test.ts`
Expected: FAIL — `requestVerdict` is not exported from `./verify` yet.

- [ ] **Step 3: Implement `requestVerdict`, delete the old parser and call site**

In `apps/web/src/server/tick/verify.ts`, replace the import block (lines 1-14) with:

```typescript
import { randomUUID } from 'node:crypto';

import { anthropic } from '@ai-sdk/anthropic';
import { Octokit } from '@octokit/rest';
import { and, eq, isNotNull } from 'drizzle-orm';
import { generateObject, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';

import { ledgerEvents, missions, tasks, type Task } from '@forge/db';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { resolveGateFlags } from './gate-flags';
import { afterVerifyStatus } from './gates';
import { getSkill } from './skill-loader';
```

Delete the `aiClient()` singleton (originally lines 44-51).

In `buildVerifyPrompt()`, delete the trailing `## Instructions` paragraph (originally lines 71-78) — the function now ends right after the diff code fence's closing line.

Delete `parseVerdict()` (originally lines 86-105) entirely, and add `requestVerdict` in its place:

```typescript
const VerdictSchema = z.object({
  verdict: z.enum(['done', 'incomplete']),
  missing: z.string().optional(),
});

/**
 * Ask the checker model whether a diff satisfies its acceptance criteria.
 * Never throws for a malformed model response — falls back to `incomplete`,
 * matching the "never silently passes a Task as done" invariant.
 */
export async function requestVerdict(opts: {
  acceptanceCriteria: string;
  diff: string;
  model: string;
}): Promise<{ verdict: Verdict; tokensUsed: number }> {
  const prompt = buildVerifyPrompt(opts.acceptanceCriteria, opts.diff);
  try {
    const { object, usage } = await generateObject({
      model: anthropic(opts.model),
      schema: VerdictSchema,
      prompt,
    });
    return {
      verdict: object,
      tokensUsed: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    };
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      return {
        verdict: {
          verdict: 'incomplete',
          missing: `unparseable verifier response: ${(error.text ?? '').slice(0, 200)}`,
        },
        tokensUsed: (error.usage?.inputTokens ?? 0) + (error.usage?.outputTokens ?? 0),
      };
    }
    throw error;
  }
}
```

In `verifyOne()`, replace the model-call block (originally lines 221-233 — the `const ai = aiClient(); const message = await ai.messages.create(...)` through `const tokensUsed = ...`):

```typescript
  const { verdict, tokensUsed } = await requestVerdict({
    acceptanceCriteria: task.acceptanceCriteria,
    diff,
    model: verifyModel,
  });
```

(`verifyModel` is still computed exactly as before — the `let verifyModel = env.VERIFY_MODEL; if (mission.skillId) {...}` block above it, originally lines 214-219, is unchanged.)

- [ ] **Step 4: Delete the now-obsolete `parseVerdict` tests**

In `apps/web/src/server/tick/verify.test.ts`, delete the entire `describe('parseVerdict', ...)` block. Keep `buildVerifyPrompt`, `buildVerifyFeedback`, and the new `requestVerdict` describe block from Step 1.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @forge/web exec vitest run src/server/tick/verify.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 6: Run the whole-workspace checks**

```bash
pnpm typecheck
pnpm test
```

Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/tick/verify.ts apps/web/src/server/tick/verify.test.ts
git commit -m "refactor(tick): migrate verify.ts to generateObject"
```

---

### Task 4: Migrate `llm-planner.ts` to `generateObject`

**Files:**
- Modify: `apps/web/src/lib/llm-planner.ts`
- Create: `apps/web/src/lib/llm-planner.test.ts` (net new — no test file exists today)

**Interfaces:**
- Consumes: same as Tasks 2-3.
- Produces: `export async function requestPlan(opts: { goal: string; repos: string[] }): Promise<LlmPlanResponse>` (new export; `LlmPlanResponse`/`LlmTask` types stay module-private as they are today — export them too, since the test needs to reference the shape). Re-throws `Error('LLM planner: failed to parse Claude response as JSON: ...')` on a malformed model response — same message shape as today, not a new behavior.

- [ ] **Step 1: Write the failing tests** — create `apps/web/src/lib/llm-planner.test.ts`:

```typescript
import { NoObjectGeneratedError } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateObject: mocks.generateObject };
});
vi.mock('@/lib/env', () => ({ env: { ANTHROPIC_API_KEY: 'test-key' } }));

describe('requestPlan', () => {
  beforeEach(() => {
    mocks.generateObject.mockReset();
  });

  it('returns the schema-shaped plan on success', async () => {
    mocks.generateObject.mockResolvedValueOnce({
      object: {
        reasoning: 'one task per repo',
        tasks: [
          { repo: 'acme/api', label: 'bump lodash', prompt: 'bump lodash to latest', dependsOnIndices: [] },
        ],
      },
      usage: { inputTokens: 300, outputTokens: 40 },
    });

    const { requestPlan } = await import('./llm-planner');
    const plan = await requestPlan({ goal: 'bump lodash everywhere', repos: ['acme/api'] });

    expect(plan.reasoning).toBe('one task per repo');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toEqual({
      repo: 'acme/api',
      label: 'bump lodash',
      prompt: 'bump lodash to latest',
      dependsOnIndices: [],
    });
  });

  it('re-throws the same error message shape on a malformed model response', async () => {
    mocks.generateObject.mockRejectedValueOnce(
      new NoObjectGeneratedError({
        text: 'not json at all',
        response: {} as never,
        usage: { inputTokens: 10, outputTokens: 2 } as never,
        finishReason: 'stop',
      }),
    );

    const { requestPlan } = await import('./llm-planner');
    await expect(requestPlan({ goal: 'x', repos: ['acme/api'] })).rejects.toThrow(
      /LLM planner: failed to parse Claude response as JSON: not json at all/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @forge/web exec vitest run src/lib/llm-planner.test.ts`
Expected: FAIL — `requestPlan` is not exported from `./llm-planner` yet (and the file doesn't exist as a module target for `vi.mock('@/lib/env', ...)` to matter yet either — the import itself will fail first).

- [ ] **Step 3: Implement `requestPlan`, delete the old client + parse block**

In `apps/web/src/lib/llm-planner.ts`, replace the import block (lines 1-10) with:

```typescript
import { randomUUID } from 'node:crypto';

import { anthropic } from '@ai-sdk/anthropic';
import { eq } from 'drizzle-orm';
import { generateObject, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';

import { ledgerEvents, missions, tasks, type NewTask } from '@forge/db';

import { db } from './db';
import { env } from './env';
import { PlannerError, type PlanResult } from './planner';
```

Change the `LlmTask`/`LlmPlanResponse` type declarations (originally lines 84-94) to be exported (needed so the test file's assertions type-check against the real shape), and add the zod schema right after them:

```typescript
export type LlmTask = {
  repo: string;
  label: string;
  prompt: string;
  dependsOnIndices: number[];
};

export type LlmPlanResponse = {
  reasoning: string;
  tasks: LlmTask[];
};

const LlmPlanSchema = z.object({
  reasoning: z.string(),
  tasks: z.array(
    z.object({
      repo: z.string(),
      label: z.string(),
      prompt: z.string(),
      dependsOnIndices: z.array(z.number()),
    }),
  ),
});
```

Add `requestPlan` right after the `SYSTEM_PROMPT` constant (originally ending at line 125):

```typescript
/**
 * Ask the model to decompose a goal into per-repo tasks. Re-throws the same
 * error message shape as before on a malformed response — deliberately not
 * relying on generateObject's internal retry, so a bad response stays a
 * visible, immediate failure rather than a silent retry.
 */
export async function requestPlan(opts: {
  goal: string;
  repos: string[];
}): Promise<LlmPlanResponse> {
  const userMessage = `Goal: ${opts.goal || '(no goal provided)'}

Allowed repositories (you must only use repos from this list):
${opts.repos.map((r) => `  - ${r}`).join('\n')}

Decompose this goal into agent tasks.`;

  try {
    const { object } = await generateObject({
      model: anthropic('claude-sonnet-4-6'),
      schema: LlmPlanSchema,
      instructions: SYSTEM_PROMPT,
      prompt: userMessage,
    });
    return object;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new Error(
        `LLM planner: failed to parse Claude response as JSON: ${(error.text ?? '').slice(0, 200)}`,
      );
    }
    throw error;
  }
}
```

In `runLlmPlanner()`, replace the "2. Call Claude" block through the JSON-parse block (originally lines 153-195 — from `const apiKey = env.ANTHROPIC_API_KEY;` through the `if (plan.tasks.length > 20) {...}` check) with:

```typescript
  // 2. Ask the model to decompose the goal into tasks.
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set; cannot run LLM planner');
  }

  const plan = await requestPlan({ goal: mission.goal ?? '', repos });

  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('LLM planner: Claude returned no tasks');
  }
  if (plan.tasks.length > 20) {
    throw new Error(`LLM planner: Claude returned ${plan.tasks.length} tasks (max 20)`);
  }
```

(The repo-allowlist validation, DAG validation, and DB transaction that follow — originally starting at "Validate that all repos are in the allowed list" — are untouched; they already operate on `plan.tasks`, which still has the same shape.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @forge/web exec vitest run src/lib/llm-planner.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 5: Run the whole-workspace checks**

```bash
pnpm typecheck
pnpm test
```

Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/llm-planner.ts apps/web/src/lib/llm-planner.test.ts
git commit -m "refactor: migrate llm-planner.ts to generateObject, add first test coverage"
```
