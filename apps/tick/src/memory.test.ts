import { describe, expect, it } from 'vitest';

import type { Memory } from '@forge/db';

import { formatMemoriesForPrompt } from './memory';

function mem(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem_test',
    scope: 'repo',
    scopeKey: 'acme/api',
    key: 'test_key',
    value: 'test value',
    confidence: 80,
    sourceType: 'retrospective',
    sourceId: null,
    learnedAt: new Date(),
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('formatMemoriesForPrompt', () => {
  it('returns empty string for no memories', () => {
    expect(formatMemoriesForPrompt([])).toBe('');
  });

  it('formats a single memory', () => {
    const result = formatMemoriesForPrompt([mem()]);
    expect(result).toContain('## Forge Memories');
    expect(result).toContain('[repo/acme/api] test_key: test value (confidence: 80%)');
  });

  it('formats multiple memories', () => {
    const result = formatMemoriesForPrompt([
      mem({ key: 'a', value: 'val_a', confidence: 90 }),
      mem({ key: 'b', value: 'val_b', scope: 'global', scopeKey: '_', confidence: 50 }),
    ]);
    expect(result).toContain('a: val_a (confidence: 90%)');
    expect(result).toContain('[global/_] b: val_b (confidence: 50%)');
  });

  it('rounds confidence to integer', () => {
    const result = formatMemoriesForPrompt([mem({ confidence: 73 })]);
    expect(result).toContain('confidence: 73%');
  });

  it('includes instructional header', () => {
    const result = formatMemoriesForPrompt([mem()]);
    expect(result).toContain('learned from previous Missions');
  });
});
