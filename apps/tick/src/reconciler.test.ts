import { describe, expect, it } from 'vitest';

import { MISSION_TERMINAL_TASK_STATUSES, DEPENDENCY_FAILED_STATUSES } from './reconciler';

describe('MISSION_TERMINAL_TASK_STATUSES', () => {
  it('includes merged as terminal', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toContain('merged');
  });

  it('includes awaiting_review as terminal (human takes over)', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toContain('awaiting_review');
  });

  it('includes abandoned as terminal', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toContain('abandoned');
  });

  it('includes failed as terminal', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toContain('failed');
  });

  it('excludes active execution states', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('queued');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('dispatching');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('running');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('turn_ended');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('opening_pr');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('awaiting_ci');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('awaiting_ai_review');
    expect(MISSION_TERMINAL_TASK_STATUSES).not.toContain('merging');
  });

  it('has exactly 4 terminal states', () => {
    expect(MISSION_TERMINAL_TASK_STATUSES).toHaveLength(4);
  });
});

describe('DEPENDENCY_FAILED_STATUSES', () => {
  it('includes failed', () => {
    expect(DEPENDENCY_FAILED_STATUSES).toContain('failed');
  });

  it('includes abandoned', () => {
    expect(DEPENDENCY_FAILED_STATUSES).toContain('abandoned');
  });

  it('has exactly 2 statuses', () => {
    expect(DEPENDENCY_FAILED_STATUSES).toHaveLength(2);
  });
});
