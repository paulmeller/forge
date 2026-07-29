import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withAuth: vi.fn(),
  revokeSessionById: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/with-auth', () => ({ withAuth: mocks.withAuth }));
vi.mock('@/lib/sessions', () => ({ revokeSessionById: mocks.revokeSessionById }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { revokeSessionAction } = await import('./actions');

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withAuth.mockResolvedValue({ id: 'usr_alice', name: 'Alice', email: 'a@example.com' });
  mocks.revokeSessionById.mockResolvedValue({ ok: true });
});

describe('revokeSessionAction', () => {
  it('revokes the session named on the form and refreshes the list', async () => {
    const state = await revokeSessionAction(form({ sessionId: 'ses_cli' }));

    expect(mocks.revokeSessionById).toHaveBeenCalledWith('ses_cli');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/sessions');
    expect(state).toEqual({ ok: true });
  });

  it('requires a session before it will revoke anything', async () => {
    mocks.withAuth.mockRejectedValue(new Error('NEXT_REDIRECT'));

    await expect(revokeSessionAction(form({ sessionId: 'ses_cli' }))).rejects.toThrow();
    expect(mocks.revokeSessionById).not.toHaveBeenCalled();
  });

  it('refuses a submission with no session id', async () => {
    const state = await revokeSessionAction(form({}));

    expect(state.error).toBeTruthy();
    expect(mocks.revokeSessionById).not.toHaveBeenCalled();
  });

  it('surfaces the refusal and does not claim success', async () => {
    mocks.revokeSessionById.mockResolvedValue({ ok: false, error: 'That session is no longer active.' });

    const state = await revokeSessionAction(form({ sessionId: 'ses_gone' }));

    expect(state).toEqual({ error: 'That session is no longer active.' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
