import { describe, expect, it } from 'vitest';
import { fail, ok } from './respond';

describe('respond', () => {
  it('wraps success data unchanged', async () => {
    const res = ok({ id: 'm1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'm1' });
  });

  it('uses one error shape for every failure', async () => {
    const res = fail('not_found', 'Mission not found', 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Mission not found' } });
  });
});
