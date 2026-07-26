import type { Mission, Task } from '@forge/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const inflightStatuses = [
    'dispatching',
    'running',
    'turn_ended',
    'opening_pr',
    'awaiting_ci',
    'awaiting_verify',
    'awaiting_ai_review',
    'awaiting_review',
    'merging',
  ];

  const state = {
    tasks: [] as Array<{
      id: string;
      missionId: string;
      status: string;
      dispatchedAt: Date | null;
      updatedAt: Date;
    }>,
    countQueue: [] as number[],
    selectedIdBatches: [] as string[][],
    concurrencyCap: 1,
    lastInflight: 0,
    maxSlotsOverride: undefined as number | undefined,
    selectAllStatuses: false,
    lastLimitArg: undefined as number | undefined,
    updateSetCalls: [] as Array<Partial<Task>>,
    env: {
      GITHUB_APP_TOKEN: undefined as string | undefined,
      FORGE_GIT_AUTHOR_NAME: 'Forge Agent',
      FORGE_GIT_AUTHOR_EMAIL: 'forge-agent@users.noreply.github.com',
    },
  };

  const reset = () => {
    state.tasks = [];
    state.countQueue = [];
    state.selectedIdBatches = [];
    state.concurrencyCap = 1;
    state.lastInflight = 0;
    state.maxSlotsOverride = undefined;
    state.selectAllStatuses = false;
    state.lastLimitArg = undefined;
    state.updateSetCalls = [];
    state.env.GITHUB_APP_TOKEN = undefined;
    state.env.FORGE_GIT_AUTHOR_NAME = 'Forge Agent';
    state.env.FORGE_GIT_AUTHOR_EMAIL = 'forge-agent@users.noreply.github.com';
  };

  const adapter = {
    kind: 'managed-agents',
    createSession: vi.fn(),
    sendTurn: vi.fn(),
    listEvents: vi.fn(),
    getSession: vi.fn(),
    cancelSession: vi.fn(),
    confirmToolUse: vi.fn(),
  };

  const getAdapter = vi.fn(() => adapter);
  const fetchAgentsMd = vi.fn(async () => ({ content: '', file: null, truncated: false }));
  const getRelevantMemories = vi.fn(async () => []);
  const formatMemoriesForPrompt = vi.fn(() => '');
  const getSkill = vi.fn(async () => null);

  const db = {
    select: vi.fn((selection?: { count?: unknown }) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          if (selection && 'count' in selection) {
            const queuedCount = state.countQueue.shift();
            const count =
              queuedCount ??
              state.tasks.filter((task) => inflightStatuses.includes(task.status)).length;
            state.lastInflight = count;
            return Promise.resolve([{ count }]);
          }

          return {
            limit: vi.fn(async (limit: number) => {
              state.lastLimitArg = limit;
              const rows = state.selectAllStatuses
                ? state.tasks
                : state.tasks.filter((task) => task.status === 'queued');
              const selected = rows.slice(0, limit);
              const ownSlots = Math.max(0, state.concurrencyCap - state.lastInflight);
              const slots =
                state.maxSlotsOverride !== undefined
                  ? Math.min(ownSlots, state.maxSlotsOverride)
                  : ownSlots;
              state.selectedIdBatches.push(selected.slice(0, slots).map((task) => task.id));
              return selected;
            }),
          };
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Partial<Task>) => {
        // Record every payload passed to .set(...) so tests can assert on
        // what dispatchOne actually persists, independent of whether the
        // chain also calls .returning() (claimNextBatch does; dispatchOne
        // does not).
        state.updateSetCalls.push(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              const ids = state.selectedIdBatches.shift() ?? [];
              const claimed: typeof state.tasks = [];
              for (const id of ids) {
                const task = state.tasks.find((candidate) => candidate.id === id);
                if (!task || task.status !== 'queued') continue;
                Object.assign(task, values);
                claimed.push(task);
              }
              return claimed;
            }),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };

  return {
    adapter,
    db,
    fetchAgentsMd,
    formatMemoriesForPrompt,
    getAdapter,
    getRelevantMemories,
    getSkill,
    reset,
    state,
  };
});

vi.mock('@/lib/db', () => ({ db: mocks.db }));
vi.mock('./adapters', () => ({ getAdapter: mocks.getAdapter }));
vi.mock('@/lib/env', () => ({ env: mocks.state.env }));
vi.mock('./agents-md', () => ({ fetchAgentsMd: mocks.fetchAgentsMd }));
vi.mock('./memory', () => ({
  formatMemoriesForPrompt: mocks.formatMemoriesForPrompt,
  getRelevantMemories: mocks.getRelevantMemories,
}));
vi.mock('./skill-loader', () => ({
  getSkill: mocks.getSkill,
  getSkillBySlug: mocks.getSkill,
}));

import { claimNextBatch, computeContainerCaps, depsSatisfied, dispatchOne, INFLIGHT_STATUSES } from './dispatcher';
import { renderPrompt } from './prompt';

function mission(overrides: Partial<Mission> = {}): Mission {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'mis_1',
    userId: 'user_1',
    name: 'Test mission',
    goal: 'Work on {{repo}} from {{base_branch}}',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    targetRepos: ['acme/repo'],
    issueQuery: null,
    concurrencyCap: 2,
    budgetUsd: null,
    budgetTokens: null,
    budgetThresholdPct: 80,
    spentUsd: 0,
    spentTokens: 0,
    autoMergePolicy: null,
    webhookSecret: 'secret',
    githubInstallationId: 'inst_1',
    githubVaultId: null,
    workspaceRepo: null,
    issueRef: null,
    parentMissionId: null,
    nextIssueRefs: null,
    skillId: null,
    aiReviewEnabled: false,
    budgetHardStopPct: 100,
    taskMaxTokens: null,
    taskMaxTurns: null,
    noProgressTokens: null,
    selfVerifyEnabled: false,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    ...overrides,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id,
    missionId: 'mis_1',
    repo: 'acme/repo',
    baseBranch: 'main',
    promptVars: null,
    issueRef: null,
    kind: 'standard',
    verdict: null,
    dependsOnIds: null,
    status: 'queued',
    sessionId: null,
    backendSessionRef: null,
    prUrl: null,
    prNumber: null,
    diffAdditions: null,
    diffDeletions: null,
    filesChanged: null,
    retryCount: 0,
    aiReviewRetryCount: 0,
    turnCount: 0,
    lastProgressAt: null,
    costTokensAtProgress: 0,
    verifyRetryCount: 0,
    lastVerifiedSha: null,
    haltReason: null,
    acceptanceCriteria: null,
    lastError: null,
    costUsd: 0,
    costTokens: 0,
    createdAt: now,
    updatedAt: now,
    dispatchedAt: null,
    completedAt: null,
    ...overrides,
  };
}

async function claim(overrides: Partial<Mission> = {}, maxSlots?: number): Promise<Task[]> {
  const currentMission = mission(overrides);
  mocks.state.concurrencyCap = currentMission.concurrencyCap;
  mocks.state.maxSlotsOverride = maxSlots;
  return claimNextBatch(currentMission, maxSlots);
}

beforeEach(() => {
  mocks.reset();
  vi.clearAllMocks();
});

describe('INFLIGHT_STATUSES', () => {
  it('includes every active execution state', () => {
    expect(INFLIGHT_STATUSES).toEqual([
      'dispatching',
      'running',
      'turn_ended',
      'opening_pr',
      'awaiting_ci',
      'awaiting_verify',
      'awaiting_ai_review',
      'awaiting_review',
      'merging',
    ]);
  });

  it('excludes queued and terminal states', () => {
    expect(INFLIGHT_STATUSES).not.toContain('queued');
    expect(INFLIGHT_STATUSES).not.toContain('merged');
    expect(INFLIGHT_STATUSES).not.toContain('abandoned');
    expect(INFLIGHT_STATUSES).not.toContain('failed');
  });
});

describe('claimNextBatch', () => {
  it('returns empty when the concurrency cap is reached', async () => {
    mocks.state.countQueue = [2];
    mocks.state.tasks = [task('t1'), task('t2')];

    await expect(claim({ concurrencyCap: 2 })).resolves.toEqual([]);
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it('claims only available slots under the concurrency cap', async () => {
    mocks.state.countQueue = [1];
    mocks.state.tasks = [task('t1'), task('t2'), task('t3')];

    const claimed = await claim({ concurrencyCap: 3 });

    expect(claimed.map((row) => row.id)).toEqual(['t1', 't2']);
    expect(mocks.state.tasks.map((row) => row.status)).toEqual([
      'dispatching',
      'dispatching',
      'queued',
    ]);
  });

  it('returns empty when maxSlots is 0, even though the mission concurrencyCap has room', async () => {
    mocks.state.countQueue = [0];
    mocks.state.tasks = [task('t1'), task('t2')];

    await expect(claim({ concurrencyCap: 3 }, 0)).resolves.toEqual([]);
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it('caps claimed tasks to maxSlots when it is more restrictive than the mission concurrencyCap', async () => {
    mocks.state.countQueue = [0];
    mocks.state.tasks = [task('t1'), task('t2'), task('t3')];

    const claimed = await claim({ concurrencyCap: 3 }, 1);

    // The real code's slots computation (min(ownSlots, maxSlots) = min(3,1) = 1)
    // is what's passed to .limit(slots * 3) — this is driven by production
    // code, not by the mock's own maxSlotsOverride bookkeeping, so it would
    // fail if claimNextBatch silently ignored maxSlots.
    expect(mocks.state.lastLimitArg).toBe(3);
    expect(claimed.map((row) => row.id)).toEqual(['t1']);
  });

  it('counts every INFLIGHT_STATUSES value against capacity', async () => {
    mocks.state.tasks = [
      ...INFLIGHT_STATUSES.map((status, index) => task(`inflight-${index}`, { status })),
      task('t1'),
      task('t2'),
      task('t3'),
    ];

    const claimed = await claim({ concurrencyCap: INFLIGHT_STATUSES.length + 2 });

    expect(claimed.map((row) => row.id)).toEqual(['t1', 't2']);
    expect(mocks.state.tasks.find((row) => row.id === 't3')?.status).toBe('queued');
  });

  it('does not count terminal statuses against capacity', async () => {
    mocks.state.tasks = [
      task('done', { status: 'merged' }),
      task('abandoned', { status: 'abandoned' }),
      task('failed', { status: 'failed' }),
      task('t1'),
      task('t2'),
      task('t3'),
    ];

    const claimed = await claim({ concurrencyCap: 2 });

    expect(claimed.map((row) => row.id)).toEqual(['t1', 't2']);
  });

  it('only claims tasks whose current status is queued', async () => {
    mocks.state.countQueue = [0];
    mocks.state.selectAllStatuses = true;
    mocks.state.tasks = [
      task('running', { status: 'running' }),
      task('queued'),
      task('failed', { status: 'failed' }),
    ];

    const claimed = await claim({ concurrencyCap: 3 });

    expect(claimed.map((row) => row.id)).toEqual(['queued']);
    expect(mocks.state.tasks.find((row) => row.id === 'running')?.status).toBe('running');
    expect(mocks.state.tasks.find((row) => row.id === 'failed')?.status).toBe('failed');
  });

  it('returns empty when there are no queued tasks', async () => {
    mocks.state.tasks = [task('done', { status: 'merged' })];

    await expect(claim({ concurrencyCap: 2 })).resolves.toEqual([]);
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it('does not double-claim across concurrent calls', async () => {
    mocks.state.countQueue = [0, 0];
    mocks.state.tasks = [task('t1')];

    const results = await Promise.all([claim({ concurrencyCap: 1 }), claim({ concurrencyCap: 1 })]);
    const claimedIds = results.flat().map((row) => row.id);

    expect(claimedIds).toEqual(['t1']);
    expect(mocks.state.tasks[0]?.status).toBe('dispatching');
  });
});

describe('computeContainerCaps', () => {
  it('returns no cap for missions without a parent', () => {
    const campaign = mission({ id: 'msn_campaign' });
    const caps = computeContainerCaps([campaign], new Map(), new Map());
    expect(caps.has('msn_campaign')).toBe(false);
  });

  it('caps a leaf mission by its running container concurrencyCap minus sibling inflight', () => {
    const container = mission({ id: 'msn_container', concurrencyCap: 3, status: 'running' });
    const leaf = mission({ id: 'msn_leaf', parentMissionId: 'msn_container' });
    const containersById = new Map([['msn_container', container]]);
    const caps = computeContainerCaps([container, leaf], containersById, new Map([['msn_container', 2]]));
    expect(caps.get('msn_leaf')).toBe(1);
  });

  it('floors at zero when sibling inflight already meets or exceeds the container cap', () => {
    const container = mission({ id: 'msn_container', concurrencyCap: 2, status: 'running' });
    const leaf = mission({ id: 'msn_leaf', parentMissionId: 'msn_container' });
    const containersById = new Map([['msn_container', container]]);
    const caps = computeContainerCaps([container, leaf], containersById, new Map([['msn_container', 5]]));
    expect(caps.get('msn_leaf')).toBe(0);
  });

  it('blocks all claiming (cap 0) when the leaf container is paused — Deactivate has real teeth', () => {
    const container = mission({ id: 'msn_container', concurrencyCap: 5, status: 'paused' });
    const leaf = mission({ id: 'msn_leaf', parentMissionId: 'msn_container' });
    const containersById = new Map([['msn_container', container]]);
    const caps = computeContainerCaps([leaf], containersById, new Map());
    expect(caps.get('msn_leaf')).toBe(0);
  });

  it('blocks all claiming (cap 0), not unconstrained, when the parent container is missing entirely', () => {
    const leaf = mission({ id: 'msn_leaf', parentMissionId: 'msn_missing_container' });
    const caps = computeContainerCaps([leaf], new Map(), new Map());
    expect(caps.get('msn_leaf')).toBe(0);
  });

  it('gives every sibling under the same running container the same remaining-slots ceiling', () => {
    const container = mission({ id: 'msn_container', concurrencyCap: 4, status: 'running' });
    const leafA = mission({ id: 'msn_leaf_a', parentMissionId: 'msn_container' });
    const leafB = mission({ id: 'msn_leaf_b', parentMissionId: 'msn_container' });
    const containersById = new Map([['msn_container', container]]);
    const caps = computeContainerCaps(
      [container, leafA, leafB],
      containersById,
      new Map([['msn_container', 1]]),
    );
    expect(caps.get('msn_leaf_a')).toBe(3);
    expect(caps.get('msn_leaf_b')).toBe(3);
  });
});

describe('renderPrompt', () => {
  it('substitutes repo and base_branch placeholders', () => {
    expect(
      renderPrompt('Update {{repo}} from {{base_branch}}', {
        repo: 'acme/api',
        base_branch: 'release',
      }),
    ).toBe('Update acme/api from release');
  });
});

describe('dispatchOne', () => {
  it('fails before creating a session when githubInstallationId is missing', async () => {
    await expect(dispatchOne(mission({ githubInstallationId: null }), task('t1'))).rejects.toThrow(
      'mission is missing github_installation_id',
    );
    expect(mocks.adapter.createSession).not.toHaveBeenCalled();
  });

  it('fails before creating a session when GITHUB_APP_TOKEN is not set', async () => {
    await expect(dispatchOne(mission(), task('t1'))).rejects.toThrow(
      'GITHUB_APP_TOKEN not configured',
    );
    expect(mocks.adapter.createSession).not.toHaveBeenCalled();
  });

  it('prepends the configured git identity setup ahead of everything else in the prompt', async () => {
    mocks.state.env.GITHUB_APP_TOKEN = 'ghp_test';
    mocks.state.env.FORGE_GIT_AUTHOR_NAME = 'Custom Bot';
    mocks.state.env.FORGE_GIT_AUTHOR_EMAIL = 'custom-bot@example.com';
    mocks.adapter.createSession.mockResolvedValue({ sessionId: 'ses_1' });

    await dispatchOne(mission(), task('t1'));

    expect(mocks.adapter.createSession).toHaveBeenCalledTimes(1);
    const { prompt } = mocks.adapter.createSession.mock.calls[0]![0];
    expect(prompt).toContain('git config --global user.name "Custom Bot"');
    expect(prompt).toContain('git config --global user.email "custom-bot@example.com"');
    expect(prompt.indexOf('git config --global user.name')).toBeLessThan(
      prompt.indexOf('Work on'),
    );
  });

  it('persists backendSessionRef equal to the session id returned by createSession, in the same update as sessionId', async () => {
    mocks.state.env.GITHUB_APP_TOKEN = 'ghp_test';
    mocks.adapter.createSession.mockResolvedValue({ sessionId: 'ses_abc123' });

    await dispatchOne(mission(), task('t1'));

    expect(mocks.state.updateSetCalls).toHaveLength(1);
    const payload = mocks.state.updateSetCalls[0]!;
    expect(payload.sessionId).toBe('ses_abc123');
    expect(payload.backendSessionRef).toBe('ses_abc123');
    expect(payload.status).toBe('running');
  });

  it('does not touch the tasks table at all when createSession throws', async () => {
    mocks.state.env.GITHUB_APP_TOKEN = 'ghp_test';
    mocks.adapter.createSession.mockRejectedValue(new Error('backend unavailable'));

    await expect(dispatchOne(mission(), task('t1'))).rejects.toThrow('backend unavailable');

    expect(mocks.state.updateSetCalls).toHaveLength(0);
  });
});

describe('depsSatisfied (triage reproduce→fix gate)', () => {
  it('unblocks when a standard dependency is merged', () => {
    const dep = task('rep', { status: 'merged' });
    expect(depsSatisfied(['rep'], [dep])).toBe(true);
  });

  it('unblocks a fix when its reproduce dep resolved with a positive verdict', () => {
    const dep = task('rep', {
      kind: 'reproduce',
      status: 'resolved',
      verdict: { reproduced: true, summary: 'confirmed' },
    });
    expect(depsSatisfied(['rep'], [dep])).toBe(true);
  });

  it('does NOT unblock when the reproduce verdict is negative', () => {
    const dep = task('rep', {
      kind: 'reproduce',
      status: 'resolved',
      verdict: { reproduced: false, summary: 'could not reproduce' },
    });
    expect(depsSatisfied(['rep'], [dep])).toBe(false);
  });

  it('does NOT unblock while the reproduce dep is still running', () => {
    const dep = task('rep', { kind: 'reproduce', status: 'running' });
    expect(depsSatisfied(['rep'], [dep])).toBe(false);
  });

  it('does NOT unblock a resolved reproduce dep that carries no verdict', () => {
    const dep = task('rep', { kind: 'reproduce', status: 'resolved', verdict: null });
    expect(depsSatisfied(['rep'], [dep])).toBe(false);
  });

  it('requires ALL dependencies to be satisfied', () => {
    const a = task('a', { status: 'merged' });
    const b = task('b', { kind: 'reproduce', status: 'running' });
    expect(depsSatisfied(['a', 'b'], [a, b])).toBe(false);
  });

  it('is unsatisfied when a dependency row is missing', () => {
    expect(depsSatisfied(['ghost'], [])).toBe(false);
  });
});
