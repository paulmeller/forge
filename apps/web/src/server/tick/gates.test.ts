import { describe, expect, it } from 'vitest';

import { afterVerifyStatus, postCiStatus } from './gates';

describe('afterVerifyStatus', () => {
  it('routes to AI review when enabled, else human review', () => {
    expect(afterVerifyStatus(true)).toBe('awaiting_ai_review');
    expect(afterVerifyStatus(false)).toBe('awaiting_review');
  });
});

describe('postCiStatus (green-CI routing)', () => {
  it('routes to verify when self-verify is on AND the task has criteria', () => {
    expect(
      postCiStatus({
        selfVerifyEnabled: true,
        hasAcceptanceCriteria: true,
        aiReviewEnabled: false,
      }),
    ).toBe('awaiting_verify');
    expect(
      postCiStatus({ selfVerifyEnabled: true, hasAcceptanceCriteria: true, aiReviewEnabled: true }),
    ).toBe('awaiting_verify');
  });

  it('falls through when self-verify is on but there are no criteria', () => {
    expect(
      postCiStatus({
        selfVerifyEnabled: true,
        hasAcceptanceCriteria: false,
        aiReviewEnabled: true,
      }),
    ).toBe('awaiting_ai_review');
    expect(
      postCiStatus({
        selfVerifyEnabled: true,
        hasAcceptanceCriteria: false,
        aiReviewEnabled: false,
      }),
    ).toBe('awaiting_review');
  });

  it('uses the existing AI-review/human choice when self-verify is off', () => {
    expect(
      postCiStatus({
        selfVerifyEnabled: false,
        hasAcceptanceCriteria: true,
        aiReviewEnabled: true,
      }),
    ).toBe('awaiting_ai_review');
    expect(
      postCiStatus({
        selfVerifyEnabled: false,
        hasAcceptanceCriteria: true,
        aiReviewEnabled: false,
      }),
    ).toBe('awaiting_review');
  });
});
