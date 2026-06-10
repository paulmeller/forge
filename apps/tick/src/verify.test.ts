import { describe, expect, it } from 'vitest';

import { buildVerifyFeedback, buildVerifyPrompt, parseVerdict } from './verify';

describe('parseVerdict', () => {
  it('parses a clean done verdict', () => {
    expect(parseVerdict('{"verdict":"done"}')).toEqual({ verdict: 'done' });
  });

  it('parses an incomplete verdict with the missing detail', () => {
    expect(parseVerdict('{"verdict":"incomplete","missing":"tests are failing"}')).toEqual({
      verdict: 'incomplete',
      missing: 'tests are failing',
    });
  });

  it('strips markdown code fences', () => {
    expect(parseVerdict('```json\n{"verdict":"done"}\n```')).toEqual({ verdict: 'done' });
  });

  it('treats malformed JSON as incomplete (never silently passes)', () => {
    expect(parseVerdict('not json at all').verdict).toBe('incomplete');
  });

  it('treats an unknown verdict value as incomplete', () => {
    expect(parseVerdict('{"verdict":"maybe"}').verdict).toBe('incomplete');
  });
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
