# AI SDK Structured-Output Migration — Design

**Status:** Approved (2026-07-20).

## Problem

Three call sites hand-roll what the Vercel AI SDK's `generateObject` already solves: `apps/web/src/server/tick/ai-review.ts` and `verify.ts` each call raw `@anthropic-ai/sdk` `messages.create()`, extract text blocks by hand, then `JSON.parse()` a markdown-fence-stripped string into a verdict — with a bespoke safe-default fallback on parse failure. `apps/web/src/lib/llm-planner.ts` does the same, but with **no fallback**: a malformed response just throws.

Forge already depends on the AI SDK (`ai@^6.0.169`, `@ai-sdk/anthropic@^3.0.72`) and uses it in `api/chat/route.ts` (`streamText`) — these three files are the odd ones out, not the norm.

`ai`'s `latest` npm dist-tag is `7.0.31` (v6 is no longer current). Investigated whether to migrate on the installed v6 or bundle a v7 upgrade: the v6→v7 breaking-change surface that touches this codebase is exactly two mechanical renames in `api/chat/route.ts` (`stepCountIs`→`isStepCount`, `streamText`'s `system:`→`instructions:`) — smaller than the migration itself, and the installed `ai@6.0.169` is already behind current v6. Bundling avoids redoing this work at the next upgrade.

## Design

### A. Package bump (touches `api/chat/route.ts` only)

`ai` → `^7.0.31`, `@ai-sdk/anthropic` → `^4.0.16`, `@ai-sdk/google`/`@ai-sdk/openai`/`@ai-sdk/react` → their v7-line equivalents. In `api/chat/route.ts`: `stepCountIs` → `isStepCount` (import at line 6, call at line 57), `system: SYSTEM_PROMPT` → `instructions: SYSTEM_PROMPT` (line 55). No other file in the repo references either symbol. `generateObject` itself is not removed or renamed in v7 — confirmed against Vercel's migration guide, not assumed.

### B. `ai-review.ts` and `verify.ts` → `generateObject`

Both files currently: build a prompt whose final paragraph asks the model to reply with a specific raw JSON shape, call `ai.messages.create({model, max_tokens: 1024, messages})` via a private `aiClient()` singleton wrapping `@anthropic-ai/sdk`, extract `message.content` text blocks by hand, strip markdown fences, `JSON.parse()`, and on any failure return a safe default (`reject` / `incomplete` respectively — "never silently pass").

Replace with `generateObject({ model: anthropic(modelId), schema, prompt })` from `@ai-sdk/anthropic`/`ai`. Schemas match the existing exported types exactly, so every downstream consumer (`reviewOne`'s `review.decision`/`review.feedback`, `verifyOne`'s `verdict.verdict`/`verdict.missing`) is unchanged:

- `ai-review.ts`: `z.object({ decision: z.enum(['approve', 'reject']), feedback: z.string() })`
- `verify.ts`: `z.object({ verdict: z.enum(['done', 'incomplete']), missing: z.string().optional() })`

Deleted: `parseReviewResponse()` / `parseVerdict()`, the raw `Anthropic` import + `aiClient()` singleton, the `message.content.filter(...).join('')` extraction, and each prompt's trailing "Respond with a JSON object in exactly this format..." instruction paragraph (the schema enforces shape now — no need to ask in prose). `buildReviewPrompt()`/`buildVerifyPrompt()` stay, minus that one paragraph each, and stay exported for testing.

The malformed-output fallback is preserved, not dropped: wrap the `generateObject` call in try/catch, catch `NoObjectGeneratedError` (from `'ai'`), and construct the same safe-default shape the current catch-block returns (`ai-review.ts`: `{decision: 'reject', feedback: 'unparseable response from AI reviewer: ' + error.text?.slice(0, 200)}`; `verify.ts`: `{verdict: 'incomplete', missing: 'unparseable verifier response: ' + error.text?.slice(0, 200)}`).

Token accounting (`tokensUsed = message.usage?.input_tokens ?? 0 + message.usage?.output_tokens ?? 0` today) becomes `usage.inputTokens + usage.outputTokens` off `generateObject`'s returned `usage` field — **the exact field-name casing must be confirmed against the installed v7 package's TypeScript types before writing this line**, not assumed from the migration guide (which documents the *cached*/*reasoning* sub-field restructuring but wasn't confirmed to also cover the base field names).

### C. `llm-planner.ts` → `generateObject`, with an explicit behavior decision

Same shape: replace `new Anthropic({apiKey}).messages.create({model, max_tokens: 4096, system: SYSTEM_PROMPT, messages})` + manual `response.content[0].text` extraction + `JSON.parse()` with `generateObject({model: anthropic('claude-sonnet-4-6'), schema, prompt})`. Schema: `z.object({ reasoning: z.string(), tasks: z.array(z.object({ repo: z.string(), label: z.string(), prompt: z.string(), dependsOnIndices: z.array(z.number()) })) })`.

Unlike the other two files, `llm-planner.ts` has **no existing safe-default fallback** — a malformed response throws `Error('LLM planner: failed to parse Claude response as JSON: ...')` today, which is a genuine, visible failure surfaced to whoever triggered planning. `generateObject`'s automatic retry-on-malformed-output would silently change that visible failure mode into an invisible retry. Decision: **preserve current external behavior exactly** — catch `NoObjectGeneratedError` and re-throw the equivalent message (`LLM planner: failed to parse Claude response as JSON: ${error.text?.slice(0, 200)}`), rather than letting the new retry behavior change what's observable. If retry-on-malformed is wanted as a deliberate feature later, that is a separate, explicit follow-up — not a side effect of this migration.

Everything after parsing (repo-allowlist validation, `validateDag()`, the DB transaction) is unchanged — it already operates on the parsed `plan` object, not on raw text, so none of that code moves.

### D. Test coverage

`ai-review.test.ts` and `verify.test.ts` today test only the pure functions being deleted (`parseReviewResponse`/`parseVerdict`) plus the prompt builders that survive. Deleting the parser tests loses coverage of exactly nothing new being *removed* — but neither file has ever had coverage of the actual AI-calling path (`reviewOne`/`verifyOne`), and `llm-planner.ts` has no test file at all. This migration adds that missing coverage rather than just deleting the old tests: for each of the three files, a `vi.mock('ai', ...)`-based test covering the happy path (schema-shaped object returned, correct downstream field mapping) and the malformed-output path (`NoObjectGeneratedError` thrown → correct fallback/re-throw).

## Acceptance

- `ai`/`@ai-sdk/anthropic`/`@ai-sdk/google`/`@ai-sdk/openai`/`@ai-sdk/react` on their v7-compatible versions; `api/chat/route.ts`'s two renames applied; chat route still builds and its existing behavior is unchanged (no test file exists for it today — verified via a manual dev-server smoke test of the chat UI, not just typecheck).
- `parseReviewResponse`, `parseVerdict`, and the raw `Anthropic`/`aiClient()` singletons no longer exist in `ai-review.ts`/`verify.ts`; `llm-planner.ts`'s raw `Anthropic` client and manual `JSON.parse` are gone.
- All three files use `generateObject` with the schemas above; every existing downstream consumer of `review`/`verdict`/`plan` fields compiles unchanged (no call-site edits beyond the parsing layer itself).
- Malformed-output behavior is preserved exactly: `ai-review.ts`/`verify.ts` produce the same safe-default fallback shape as today; `llm-planner.ts` re-throws the same error message shape as today.
- New tests exist covering the `generateObject` happy path and malformed-output path for all three files (net new for `llm-planner.ts`, which had zero test coverage before).
- `pnpm typecheck` and `pnpm test` pass across the whole workspace.
