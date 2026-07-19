import { describe, expect, it, beforeEach, vi } from 'vitest';

import { NoObjectGeneratedError } from 'ai';
import { buildVerifyFeedback, buildVerifyPrompt } from './verify';

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateObject: mocks.generateObject };
});

describe('buildVerifyPrompt', () => {
  it('embeds the criteria and the diff and asks for completeness only', () => {
    const p = buildVerifyPrompt('- a PR is open', 'diff --git a b');
    expect(p).toContain('- a PR is open');
    expect(p).toContain('diff --git a b');
    expect(p).toContain('completeness only');
  });
});

describe('buildVerifyFeedback', () => {
  it('surfaces the missing items and asks the agent to push', () => {
    const f = buildVerifyFeedback('the lockfile was not updated');
    expect(f).toContain('the lockfile was not updated');
    expect(f).toContain('push');
  });
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
