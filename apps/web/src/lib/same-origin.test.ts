import { describe, expect, it } from 'vitest';

import { rejectCrossSite } from './same-origin';

const ok = {
  contentType: 'application/json',
  origin: 'https://forge.example',
  secFetchSite: 'same-origin',
  host: 'forge.example',
  forwardedProto: 'https',
};

describe('rejectCrossSite', () => {
  it('accepts a same-origin JSON POST from the app', () => {
    expect(rejectCrossSite(ok)).toBeNull();
  });

  it('accepts a JSON content-type carrying parameters', () => {
    expect(rejectCrossSite({ ...ok, contentType: 'application/json; charset=utf-8' })).toBeNull();
  });

  // A cookie-authenticated route handler is not covered by Next's Server Action
  // origin check, so a form POST from another site would otherwise arrive
  // authenticated. This route can create missions and spend LLM budget.
  it('rejects a cross-site request even when the session cookie is valid', () => {
    expect(rejectCrossSite({ ...ok, secFetchSite: 'cross-site' })).toMatch(/cross-site/i);
  });

  it('rejects same-site (a sibling subdomain is not this origin)', () => {
    expect(rejectCrossSite({ ...ok, secFetchSite: 'same-site' })).toBeTruthy();
  });

  it('rejects an Origin that does not match the host', () => {
    expect(rejectCrossSite({ ...ok, secFetchSite: null, origin: 'https://evil.example' })).toBeTruthy();
  });

  it('accepts a matching Origin when Sec-Fetch-Site is absent', () => {
    expect(rejectCrossSite({ ...ok, secFetchSite: null })).toBeNull();
  });

  // A cross-site form POST can be sent as text/plain or urlencoded without a
  // preflight; requiring JSON forces a preflight the browser will block.
  it('rejects a non-JSON content-type', () => {
    expect(rejectCrossSite({ ...ok, contentType: 'text/plain' })).toMatch(/content-type/i);
  });

  it('rejects a missing content-type', () => {
    expect(rejectCrossSite({ ...ok, contentType: null })).toBeTruthy();
  });

  it('rejects when neither Origin nor Sec-Fetch-Site is present', () => {
    // No evidence of same-origin. This route is browser-facing and
    // cookie-authenticated, so absence is not a pass.
    expect(rejectCrossSite({ ...ok, origin: null, secFetchSite: null })).toBeTruthy();
  });

  it('honours the forwarded protocol behind a proxy', () => {
    // Cloud Run terminates TLS, so the request seen here is http while the
    // browser's Origin says https. Comparing without the forwarded proto would
    // reject every legitimate request in production.
    expect(
      rejectCrossSite({ ...ok, secFetchSite: null, origin: 'https://forge.example', forwardedProto: 'https' }),
    ).toBeNull();
  });
});
