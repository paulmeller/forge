import { describe, expect, it } from 'vitest';

import { INFLIGHT_STATUSES } from './dispatcher';

describe('INFLIGHT_STATUSES', () => {
  it('includes all active execution states', () => {
    expect(INFLIGHT_STATUSES).toContain('dispatching');
    expect(INFLIGHT_STATUSES).toContain('running');
    expect(INFLIGHT_STATUSES).toContain('turn_ended');
    expect(INFLIGHT_STATUSES).toContain('opening_pr');
    expect(INFLIGHT_STATUSES).toContain('awaiting_ci');
    expect(INFLIGHT_STATUSES).toContain('awaiting_review');
    expect(INFLIGHT_STATUSES).toContain('merging');
  });

  it('includes awaiting_ai_review', () => {
    expect(INFLIGHT_STATUSES).toContain('awaiting_ai_review');
  });

  it('excludes terminal states from inflight count', () => {
    expect(INFLIGHT_STATUSES).not.toContain('queued');
    expect(INFLIGHT_STATUSES).not.toContain('merged');
    expect(INFLIGHT_STATUSES).not.toContain('abandoned');
    expect(INFLIGHT_STATUSES).not.toContain('failed');
  });

  it('has exactly 8 statuses (no accidental additions)', () => {
    expect(INFLIGHT_STATUSES).toHaveLength(8);
  });
});
