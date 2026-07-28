import { describe, expect, it } from 'vitest';

import { parseLines } from './parse-lines';

describe('parseLines', () => {
  it('trims, drops blanks, and returns undefined for an empty textarea', () => {
    expect(parseLines('  build \n\n  test  \n')).toEqual(['build', 'test']);
    expect(parseLines('   \n  \n')).toBeUndefined();
    expect(parseLines('')).toBeUndefined();
  });
});
