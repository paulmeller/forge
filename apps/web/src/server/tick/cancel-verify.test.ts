import { describe, expect, it, vi } from 'vitest';

import { verifyCancelled } from './cancel-verify';

describe('verifyCancelled', () => {
  it('returns true when the session reports terminated', async () => {
    const adapter = {
      getSession: vi.fn(async () => ({ sessionId: 's1', status: 'terminated' as const })),
    };
    await expect(verifyCancelled(adapter, 's1', 'ref1')).resolves.toBe(true);
    expect(adapter.getSession).toHaveBeenCalledWith('s1', 'ref1');
  });

  it('returns true when the session drains to idle — the real successful-interrupt shape', async () => {
    // managed-agents and gateway cancelSession() send user.interrupt, which drains
    // the session to idle (not terminated). This must count as a verified cancel.
    const adapter = {
      getSession: vi.fn(async () => ({ sessionId: 's1', status: 'idle' as const })),
    };
    await expect(verifyCancelled(adapter, 's1', 'ref1')).resolves.toBe(true);
  });

  it('returns false when the session is still running — the silent-failure case', async () => {
    const adapter = {
      getSession: vi.fn(async () => ({ sessionId: 's1', status: 'running' as const })),
    };
    await expect(verifyCancelled(adapter, 's1', 'ref1')).resolves.toBe(false);
  });

  it('returns false when the session is rescheduling — still active', async () => {
    const adapter = {
      getSession: vi.fn(async () => ({ sessionId: 's1', status: 'rescheduling' as const })),
    };
    await expect(verifyCancelled(adapter, 's1', 'ref1')).resolves.toBe(false);
  });

  it('returns false when the status read itself throws, rather than propagating', async () => {
    const adapter = {
      getSession: vi.fn(async () => {
        throw new Error('network down');
      }),
    };
    await expect(verifyCancelled(adapter, 's1', null)).resolves.toBe(false);
  });
});
