import { describe, expect, it } from 'vitest';

import { CONTINUATION_PROMPT, decideContinuation } from './continuation';

// When an agent ends its turn without pushing a branch, Forge nudges it to
// finish rather than abandoning at the first end_turn. The nudge is bounded:
// after the budget is spent, the task escalates to a human instead of being
// dropped or ground on forever. This is the boundary that decides which.

describe('decideContinuation', () => {
  it('nudges again while under the budget', () => {
    expect(decideContinuation(0, 3)).toBe('continue');
    expect(decideContinuation(2, 3)).toBe('continue');
  });

  it('escalates once the budget is spent', () => {
    // At the boundary the budget is exhausted — the third nudge already
    // happened, so a fourth attempt escalates rather than grinding on.
    expect(decideContinuation(3, 3)).toBe('escalate');
    expect(decideContinuation(4, 3)).toBe('escalate');
  });

  it('escalates immediately when the budget is zero (nudging disabled)', () => {
    // TASK_CONTINUATION_MAX=0 turns the feature off: no nudge, straight to a
    // human. It must not fall through to "continue" and loop.
    expect(decideContinuation(0, 0)).toBe('escalate');
  });
});

describe('CONTINUATION_PROMPT', () => {
  it('tells the agent what is missing and what to do', () => {
    // The prompt is the whole mechanism — if it does not name "push a branch"
    // the nudge cannot resolve the common "forgot to push" case.
    expect(CONTINUATION_PROMPT.toLowerCase()).toContain('branch');
  });
});
