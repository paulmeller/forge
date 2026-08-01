import { describe, expect, it, vi } from 'vitest';

// M3: runAutoMerge MUST execute before runReconciler within one tick — see
// the comment above the `reconciler` call in tick.ts for why. This test pins
// that ordering directly: it mocks every sub-runner tick.ts calls, records
// the order they're actually invoked in, and asserts autoMerge comes before
// reconciler. Swap the two calls in tick.ts (or insert something between
// them that reorders them) and this fails.
const callOrder = vi.hoisted(() => [] as string[]);

function recorder<T extends object>(name: string, result: T) {
  return vi.fn(async () => {
    callOrder.push(name);
    return result;
  });
}

const mocks = vi.hoisted(() => ({
  poller: undefined as unknown,
  onboarding: undefined as unknown,
  guardrails: undefined as unknown,
  ci: undefined as unknown,
  verify: undefined as unknown,
  aiReview: undefined as unknown,
  autoMerge: undefined as unknown,
  budgets: undefined as unknown,
  reconciler: undefined as unknown,
  dispatcher: undefined as unknown,
  memory: undefined as unknown,
  deviceCodes: undefined as unknown,
}));

vi.mock('./poller', () => ({
  runPoller: (mocks.poller = recorder('poller', {
    tasksPolled: 0,
    eventsIngested: 0,
    transitions: 0,
    errors: 0,
  })),
}));
vi.mock('./onboarding', () => ({
  runOnboarding: (mocks.onboarding = recorder('onboarding', {
    reposChecked: 0,
    prsOpened: 0,
    activated: 0,
    regated: 0,
  })),
}));
vi.mock('./guardrails', () => ({
  runGuardrails: (mocks.guardrails = recorder('guardrails', {
    tasksChecked: 0,
    halted: 0,
    byReason: {},
  })),
}));
vi.mock('./ci', () => ({
  runCiPoller: (mocks.ci = recorder('ci', {
    tasksChecked: 0,
    transitionedToReview: 0,
    transitionedToFailed: 0,
    retried: 0,
    stillPending: 0,
  })),
}));
vi.mock('./verify', () => ({
  runVerify: (mocks.verify = recorder('verify', {
    tasksChecked: 0,
    passed: 0,
    retried: 0,
    escalated: 0,
    skipped: 0,
    errors: 0,
  })),
}));
vi.mock('./ai-review', () => ({
  runAiReview: (mocks.aiReview = recorder('aiReview', {
    tasksChecked: 0,
    approved: 0,
    rejected: 0,
    escalated: 0,
    errors: 0,
  })),
}));
vi.mock('./auto-merge', () => ({
  runAutoMerge: (mocks.autoMerge = recorder('autoMerge', {
    candidates: 0,
    merged: 0,
    blocked: 0,
    errors: 0,
  })),
}));
vi.mock('./budgets', () => ({
  runBudgets: (mocks.budgets = recorder('budgets', {
    missionsChecked: 0,
    paused: 0,
    hardStopped: 0,
  })),
}));
vi.mock('./reconciler', () => ({
  runReconciler: (mocks.reconciler = recorder('reconciler', {
    missionsChecked: 0,
    missionsCompleted: 0,
    tasksAbandoned: 0,
    tasksCascadeFailed: 0,
    prsOpened: 0,
    gatesEscalated: 0,
    reproduceResolved: 0,
    fixesGated: 0,
    mergesCompleted: 0,
    mergesEscalated: 0,
    mergeStallsEscalated: 0,
  })),
}));
vi.mock('./dispatcher', () => ({
  runDispatcher: (mocks.dispatcher = recorder('dispatcher', {
    missions: 0,
    claimed: 0,
    dispatched: 0,
    failed: 0,
  })),
}));
vi.mock('./memory', () => ({
  runMemoryExpiry: (mocks.memory = recorder('memory', { expired: 0, reconfirmationNeeded: 0 })),
}));
vi.mock('./device-codes', () => ({
  runDeviceCodeSweep: (mocks.deviceCodes = recorder('deviceCodes', { deleted: 0 })),
}));

const { runTick } = await import('./tick');

const log = { info: () => {}, warn: () => {}, error: () => {} };

describe('runTick — sub-runner call order', () => {
  it('runs auto-merge before the reconciler (M3)', async () => {
    callOrder.length = 0;
    await runTick(log);

    const autoMergeIndex = callOrder.indexOf('autoMerge');
    const reconcilerIndex = callOrder.indexOf('reconciler');
    expect(autoMergeIndex).toBeGreaterThanOrEqual(0);
    expect(reconcilerIndex).toBeGreaterThanOrEqual(0);
    expect(autoMergeIndex).toBeLessThan(reconcilerIndex);
  });

  it('runs every sub-runner exactly once per tick', async () => {
    callOrder.length = 0;
    await runTick(log);
    expect(callOrder).toEqual([
      'poller',
      'onboarding',
      'guardrails',
      'ci',
      'verify',
      'aiReview',
      'autoMerge',
      'budgets',
      'reconciler',
      'dispatcher',
      'memory',
      'deviceCodes',
    ]);
  });

  it('reports the device-code sweep in the tick result', async () => {
    const result = await runTick(log);
    expect(result.deviceCodes).toEqual({ deleted: 0 });
  });

  it('keeps ticking when the device-code sweep throws', async () => {
    (mocks.deviceCodes as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const result = await runTick(log);
    expect(result.deviceCodes).toEqual({ deleted: 0 });
    expect(result.memory).toEqual({ expired: 0, reconfirmationNeeded: 0 });
  });
});
