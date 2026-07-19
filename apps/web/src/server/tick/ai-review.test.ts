import { describe, expect, it } from 'vitest';

import { buildReviewPrompt } from './ai-review';

describe('buildReviewPrompt', () => {
  it('includes the mission goal', () => {
    const prompt = buildReviewPrompt({ goal: 'bump lodash', diff: '+foo', summary: '' });
    expect(prompt).toContain('bump lodash');
  });

  it('includes the diff', () => {
    const prompt = buildReviewPrompt({ goal: 'fix', diff: '+added line', summary: '' });
    expect(prompt).toContain('+added line');
  });
});

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
