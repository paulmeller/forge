import { describe, expect, it } from 'vitest';

import { afterVerifyStatus, postCiStatus } from './gates';

describe('gate routing', () => {
  it('routes a clean verify pass to ready_to_merge, not a human queue', () => {
    expect(afterVerifyStatus(false)).toBe('ready_to_merge');
  });

  it('routes to AI review when it is enabled', () => {
    expect(afterVerifyStatus(true)).toBe('awaiting_ai_review');
  });

  it('routes green CI to self-verify when enabled and criteria exist', () => {
    expect(
      postCiStatus({ selfVerifyEnabled: true, hasAcceptanceCriteria: true, aiReviewEnabled: true }),
    ).toBe('awaiting_verify');
  });

  it('routes green CI straight to ready_to_merge when both gates are off', () => {
    expect(
      postCiStatus({
        selfVerifyEnabled: false,
        hasAcceptanceCriteria: false,
        aiReviewEnabled: false,
      }),
    ).toBe('ready_to_merge');
  });

  it('falls through to afterVerifyStatus when self-verify is enabled but there are no acceptance criteria', () => {
    expect(
      postCiStatus({ selfVerifyEnabled: true, hasAcceptanceCriteria: false, aiReviewEnabled: true }),
    ).toBe('awaiting_ai_review');
  });

  it('falls through to afterVerifyStatus when acceptance criteria exist but self-verify is disabled', () => {
    expect(
      postCiStatus({ selfVerifyEnabled: false, hasAcceptanceCriteria: true, aiReviewEnabled: true }),
    ).toBe('awaiting_ai_review');
  });

  it('routes the direct fallthrough (both self-verify off, AI review on) to awaiting_ai_review', () => {
    expect(
      postCiStatus({ selfVerifyEnabled: false, hasAcceptanceCriteria: false, aiReviewEnabled: true }),
    ).toBe('awaiting_ai_review');
  });
});
