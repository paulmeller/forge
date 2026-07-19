import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    runTick: vi.fn(async () => ({ durationMs: 1 })),
  };
});

vi.mock('@/server/tick/tick', () => ({ runTick: mocks.runTick }));

import { POST } from './route';

describe('POST /api/tick', () => {
  beforeEach(() => {
    mocks.runTick.mockClear();
    mocks.runTick.mockResolvedValue({ durationMs: 1 });
    delete process.env.TICK_ALLOW_UNAUTHENTICATED;
  });

  it('401s without a bearer token when auth is required', async () => {
    const res = await POST(new Request('http://x/api/tick', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(mocks.runTick).not.toHaveBeenCalled();
  });

  it('runs a tick and returns its result when unauthenticated mode is on', async () => {
    process.env.TICK_ALLOW_UNAUTHENTICATED = 'true';
    const res = await POST(new Request('http://x/api/tick', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ durationMs: 1 });
    expect(mocks.runTick).toHaveBeenCalledOnce();
  });
});
