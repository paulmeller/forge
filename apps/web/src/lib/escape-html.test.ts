import { describe, expect, it } from 'vitest';

import { escapeHtml } from './escape-html';

describe('escapeHtml', () => {
  it('neutralises a script tag', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('escapes both quote styles so quoted attributes cannot be broken out of', () => {
    expect(escapeHtml(`" onerror='x'`)).toBe('&quot; onerror=&#39;x&#39;');
  });

  it('escapes ampersands first, so an escaped entity is not double-escaped', () => {
    // The ordering bug this guards against turns `<` into `&amp;lt;`, which
    // renders as the literal text "&lt;" instead of "<".
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('replaces every occurrence, not just the first', () => {
    expect(escapeHtml('<<')).toBe('&lt;&lt;');
  });

  it('renders null and undefined as empty rather than the string "null"', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('leaves base64/hex credential values byte-identical', () => {
    // The bootstrap page escapes secrets on the way out; that must not alter
    // what the user copies. PEM bodies and hex secrets have no metacharacters.
    const pem = 'MIIEowIBAAKCAQEAx7Vv+K/9abc123==';
    expect(escapeHtml(pem)).toBe(pem);
  });
});
