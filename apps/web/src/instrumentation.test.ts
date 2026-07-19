import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncSkillsToDb = vi.fn(async () => ({ inserted: 1, updated: 2 }));
vi.mock('@/server/tick/skill-loader', () => ({ syncSkillsToDb }));

import { register } from './instrumentation';

describe('instrumentation register()', () => {
  beforeEach(() => syncSkillsToDb.mockClear());

  it('syncs skills on nodejs runtime boot', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    await register();
    expect(syncSkillsToDb).toHaveBeenCalledOnce();
  });

  it('skips non-node runtimes', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    await register();
    expect(syncSkillsToDb).not.toHaveBeenCalled();
  });

  it('is non-fatal when the sync throws', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    syncSkillsToDb.mockRejectedValueOnce(new Error('db down'));
    await expect(register()).resolves.toBeUndefined();
  });
});
