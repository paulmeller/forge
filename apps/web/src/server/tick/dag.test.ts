import { describe, expect, it } from 'vitest';

import { validateDag } from './dag';

describe('validateDag', () => {
  it('accepts an empty task list', () => {
    expect(validateDag([])).toEqual({ valid: true, error: null });
  });

  it('accepts independent tasks (no dependencies)', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [] },
      { index: 1, dependsOnIndices: [] },
    ];
    expect(validateDag(tasks)).toEqual({ valid: true, error: null });
  });

  it('accepts a linear chain A → B → C', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [] },
      { index: 1, dependsOnIndices: [0] },
      { index: 2, dependsOnIndices: [1] },
    ];
    expect(validateDag(tasks)).toEqual({ valid: true, error: null });
  });

  it('accepts a diamond A → B, A → C, B → D, C → D', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [] },
      { index: 1, dependsOnIndices: [0] },
      { index: 2, dependsOnIndices: [0] },
      { index: 3, dependsOnIndices: [1, 2] },
    ];
    expect(validateDag(tasks)).toEqual({ valid: true, error: null });
  });

  it('rejects a direct cycle A → B → A', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [1] },
      { index: 1, dependsOnIndices: [0] },
    ];
    const result = validateDag(tasks);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cycle');
  });

  it('rejects a self-referencing task', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [0] },
    ];
    const result = validateDag(tasks);
    expect(result.valid).toBe(false);
  });

  it('rejects an indirect cycle A → B → C → A', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [2] },
      { index: 1, dependsOnIndices: [0] },
      { index: 2, dependsOnIndices: [1] },
    ];
    expect(validateDag(tasks).valid).toBe(false);
  });

  it('rejects out-of-bounds dependency index', () => {
    const tasks = [
      { index: 0, dependsOnIndices: [5] },
    ];
    const result = validateDag(tasks);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('out of bounds');
  });
});
