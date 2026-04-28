import { describe, expect, it } from 'vitest';

import { buildReviewPrompt, parseReviewResponse } from './ai-review';

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

describe('parseReviewResponse', () => {
  it('parses an approve response', () => {
    const result = parseReviewResponse('{"decision":"approve","feedback":"looks good"}');
    expect(result).toEqual({ decision: 'approve', feedback: 'looks good' });
  });

  it('parses a reject response', () => {
    const result = parseReviewResponse('{"decision":"reject","feedback":"missing tests"}');
    expect(result).toEqual({ decision: 'reject', feedback: 'missing tests' });
  });

  it('returns reject for unparseable response', () => {
    const result = parseReviewResponse('not json');
    expect(result.decision).toBe('reject');
    expect(result.feedback).toContain('unparseable');
  });

  it('returns reject for missing decision field', () => {
    const result = parseReviewResponse('{"feedback":"hi"}');
    expect(result.decision).toBe('reject');
  });
});
