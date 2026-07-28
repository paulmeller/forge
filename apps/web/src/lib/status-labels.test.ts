import { describe, expect, it } from 'vitest';

import { STATUS_LABELS, statusLabel } from './status-labels';

describe('statusLabel', () => {
  it('maps every known machine string to a non-snake human label', () => {
    for (const [machine, label] of Object.entries(STATUS_LABELS)) {
      expect(statusLabel(machine)).toBe(label);
      expect(label).not.toMatch(/_/);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('spot-checks the spec table', () => {
    expect(statusLabel('ready_to_merge')).toBe('Ready to merge');
    expect(statusLabel('needs_human')).toBe('Needs you');
    expect(statusLabel('fix_review')).toBe('Reviewing fix');
    expect(statusLabel('awaiting_ci')).toBe('Waiting on CI');
    expect(statusLabel('not_reproduced')).toBe('Not reproduced');
    expect(statusLabel('running')).toBe('Running');
  });

  it('falls back to the raw string for unknown values', () => {
    expect(statusLabel('some_future_status')).toBe('some_future_status');
  });
});
