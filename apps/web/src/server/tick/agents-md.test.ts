import { describe, expect, it } from 'vitest';

import { truncateAgentsMd, AGENTS_MD_MAX_CHARS } from './agents-md';

describe('truncateAgentsMd', () => {
  it('returns content unchanged if under limit', () => {
    expect(truncateAgentsMd('short')).toBe('short');
  });

  it('truncates content over limit and appends notice', () => {
    const long = 'x'.repeat(AGENTS_MD_MAX_CHARS + 100);
    const result = truncateAgentsMd(long);
    expect(result.length).toBeLessThanOrEqual(AGENTS_MD_MAX_CHARS + 100);
    expect(result).toContain('[... truncated');
  });

  it('uses correct max chars constant', () => {
    expect(AGENTS_MD_MAX_CHARS).toBe(8000);
  });
});
