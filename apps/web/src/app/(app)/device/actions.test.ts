import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withAuth: vi.fn(),
  findDeviceRequest: vi.fn(),
  decideDeviceRequest: vi.fn(),
}));

vi.mock('@/lib/with-auth', () => ({ withAuth: mocks.withAuth }));
vi.mock('@/lib/device-auth', () => ({
  findDeviceRequest: mocks.findDeviceRequest,
  decideDeviceRequest: mocks.decideDeviceRequest,
}));

const { decideDeviceAction, lookupDeviceAction } = await import('./actions');

const SESSION_USER = { id: 'usr_session', name: 'Session User', email: 's@example.com' };

/** Stand-in for the HMAC lib/device-auth.ts mints; its shape is pinned there. */
const CONSENT = 'consent-token-from-step-one';

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withAuth.mockResolvedValue(SESSION_USER);
});

describe('lookupDeviceAction', () => {
  it('looks the request up by the code the human typed', async () => {
    mocks.findDeviceRequest.mockResolvedValue({
      userCode: 'ABCD2345',
      clientId: 'forge-cli',
      scope: null,
      consentToken: CONSENT,
    });

    const state = await lookupDeviceAction(form({ userCode: 'abcd-2345' }));

    // The session user, not anything on the form, is what the token is bound
    // to — the lookup has to know who is asking to mint one.
    expect(mocks.findDeviceRequest).toHaveBeenCalledWith('abcd-2345', SESSION_USER.id);
    expect(state.request).toEqual({
      userCode: 'ABCD2345',
      clientId: 'forge-cli',
      scope: null,
      consentToken: CONSENT,
    });
  });

  it('requires a session before it will look anything up', async () => {
    mocks.withAuth.mockRejectedValue(new Error('NEXT_REDIRECT'));

    await expect(lookupDeviceAction(form({ userCode: 'abcd-2345' }))).rejects.toThrow();
    expect(mocks.findDeviceRequest).not.toHaveBeenCalled();
  });

  it('reports an unknown code without looking like anything else happened', async () => {
    mocks.findDeviceRequest.mockResolvedValue(null);

    const state = await lookupDeviceAction(form({ userCode: 'zzzz9999' }));

    expect(state.request).toBeUndefined();
    expect(state.error).toBeTruthy();
  });

  it('refuses an empty field instead of asking for "whatever is pending"', async () => {
    const state = await lookupDeviceAction(form({ userCode: '   ' }));

    expect(state.error).toBeTruthy();
    expect(mocks.findDeviceRequest).not.toHaveBeenCalled();
  });

  it('refuses a submission with no code field at all', async () => {
    const state = await lookupDeviceAction(form({}));

    expect(state.error).toBeTruthy();
    expect(mocks.findDeviceRequest).not.toHaveBeenCalled();
  });
});

describe('decideDeviceAction', () => {
  it('approves exactly the code carried on the form', async () => {
    mocks.decideDeviceRequest.mockResolvedValue({
      ok: true,
      decision: 'approve',
      clientId: 'forge-cli',
    });

    const state = await decideDeviceAction(form({ userCode: 'ABCD2345', op: 'approve', consentToken: CONSENT }));

    expect(mocks.decideDeviceRequest).toHaveBeenCalledWith('ABCD2345', SESSION_USER.id, 'approve', CONSENT);
    expect(state).toEqual({ decided: 'approve', clientId: 'forge-cli' });
  });

  it('denies exactly the code carried on the form', async () => {
    mocks.decideDeviceRequest.mockResolvedValue({
      ok: true,
      decision: 'deny',
      clientId: 'forge-cli',
    });

    const state = await decideDeviceAction(form({ userCode: 'ABCD2345', op: 'deny', consentToken: CONSENT }));

    expect(mocks.decideDeviceRequest).toHaveBeenCalledWith('ABCD2345', SESSION_USER.id, 'deny', CONSENT);
    expect(state.decided).toBe('deny');
  });

  it('binds the approval to the session user, never to an id supplied by the form', async () => {
    // A form field is attacker-controlled. If this action ever sourced the
    // approving identity from the request, the device code would be bound to
    // whoever the submitter named — which is finding 1 with extra steps.
    mocks.decideDeviceRequest.mockResolvedValue({
      ok: true,
      decision: 'approve',
      clientId: 'forge-cli',
    });

    await decideDeviceAction(form({ userCode: 'ABCD2345', op: 'approve', userId: 'usr_victim', consentToken: CONSENT }));

    expect(mocks.decideDeviceRequest).toHaveBeenCalledWith('ABCD2345', SESSION_USER.id, 'approve', CONSENT);
  });

  it('requires a session before it will decide anything', async () => {
    mocks.withAuth.mockRejectedValue(new Error('NEXT_REDIRECT'));

    await expect(
      decideDeviceAction(form({ userCode: 'ABCD2345', op: 'approve', consentToken: CONSENT })),
    ).rejects.toThrow();
    expect(mocks.decideDeviceRequest).not.toHaveBeenCalled();
  });

  it('refuses a missing code rather than deciding some other request', async () => {
    const state = await decideDeviceAction(form({ op: 'approve', consentToken: CONSENT }));

    expect(state.error).toBeTruthy();
    expect(mocks.decideDeviceRequest).not.toHaveBeenCalled();
  });

  it('refuses an operation that is neither approve nor deny', async () => {
    const state = await decideDeviceAction(form({ userCode: 'ABCD2345', op: 'delete', consentToken: CONSENT }));

    expect(state.error).toBeTruthy();
    expect(mocks.decideDeviceRequest).not.toHaveBeenCalled();
  });

  it('surfaces the refusal reason when the decision is rejected', async () => {
    mocks.decideDeviceRequest.mockResolvedValue({
      ok: false,
      code: 'ALREADY_DECIDED',
      error: 'that code has already been approved or denied',
    });

    const state = await decideDeviceAction(form({ userCode: 'ABCD2345', op: 'approve', consentToken: CONSENT }));

    expect(state.decided).toBeUndefined();
    expect(state.error).toBe('that code has already been approved or denied');
  });

  /**
   * Without a consent token, one request — a valid session cookie plus
   * `{userCode, op:'approve'}` — was a completed approval, and the "the human
   * typed the code first" step existed only in the browser. These pin that the
   * server now requires the proof and, critically, refuses BEFORE calling into
   * the decision itself: a rejection that still reached `decideDeviceRequest`
   * would be no rejection at all.
   */
  it('refuses a submission with no consent token, without deciding anything', async () => {
    const state = await decideDeviceAction(form({ userCode: 'ABCD2345', op: 'approve' }));

    expect(state.error).toBeTruthy();
    expect(state.decided).toBeUndefined();
    expect(mocks.decideDeviceRequest).not.toHaveBeenCalled();
  });

  it('refuses an empty consent token', async () => {
    const state = await decideDeviceAction(
      form({ userCode: 'ABCD2345', op: 'approve', consentToken: '' }),
    );

    expect(state.error).toBeTruthy();
    expect(mocks.decideDeviceRequest).not.toHaveBeenCalled();
  });

  it('passes a token it cannot itself judge through to be verified', async () => {
    // The action must not try to validate the token — it has no key. Its job
    // is to require one and hand it over; the HMAC check is lib/device-auth's.
    mocks.decideDeviceRequest.mockResolvedValue({
      ok: false,
      code: 'INVALID_CONSENT',
      error: 'that approval expired or did not come from this page — enter the code again',
    });

    const state = await decideDeviceAction(
      form({ userCode: 'ABCD2345', op: 'approve', consentToken: 'forged' }),
    );

    expect(mocks.decideDeviceRequest).toHaveBeenCalledWith(
      'ABCD2345',
      SESSION_USER.id,
      'approve',
      'forged',
    );
    expect(state.decided).toBeUndefined();
    expect(state.error).toBeTruthy();
  });
});
