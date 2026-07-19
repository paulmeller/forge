import { NoObjectGeneratedError } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateObject: mocks.generateObject };
});
vi.mock('@/lib/env', () => ({ env: { ANTHROPIC_API_KEY: 'test-key' } }));
vi.mock('@/lib/db', () => ({ db: {} }));

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
