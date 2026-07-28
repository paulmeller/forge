import { describe, expect, it } from 'vitest';

import { parseOptionalNumber } from './parse-optional-number';

describe('parseOptionalNumber', () => {
  it('returns undefined (not 0) for a blank or whitespace-only box', () => {
    expect(parseOptionalNumber('')).toBeUndefined();
    expect(parseOptionalNumber('   ')).toBeUndefined();
  });

  it('parses a non-blank value to its number', () => {
    expect(parseOptionalNumber('0')).toBe(0);
    expect(parseOptionalNumber('42')).toBe(42);
  });
});
