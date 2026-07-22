import { describe, expect, it } from 'vitest';

import { activeMissionTab } from './mission-tabs';

describe('activeMissionTab', () => {
  it('matches Overview only on the exact mission root path', () => {
    expect(activeMissionTab('/missions/msn_1', 'msn_1')).toBe('overview');
  });

  it('does not match Overview for a sub-route (exact match, not prefix)', () => {
    expect(activeMissionTab('/missions/msn_1/ledger', 'msn_1')).toBeNull();
  });

  it('matches Pipeline by prefix', () => {
    expect(activeMissionTab('/missions/msn_1/pipeline', 'msn_1')).toBe('pipeline');
  });

  it('matches Tools by prefix', () => {
    expect(activeMissionTab('/missions/msn_1/tools', 'msn_1')).toBe('tools');
  });

  it('matches Tasks by prefix, including nested sub-paths', () => {
    expect(activeMissionTab('/missions/msn_1/tasks', 'msn_1')).toBe('tasks');
    expect(activeMissionTab('/missions/msn_1/tasks/tsk_1', 'msn_1')).toBe('tasks');
  });

  it('returns null for unrelated routes (e.g. ledger, plan, retrospective, issues)', () => {
    expect(activeMissionTab('/missions/msn_1/plan', 'msn_1')).toBeNull();
    expect(activeMissionTab('/missions/msn_1/retrospective', 'msn_1')).toBeNull();
    expect(activeMissionTab('/missions/msn_1/issues', 'msn_1')).toBeNull();
  });
});
