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
    selectAllStatuses: false,
    env: { GITHUB_APP_TOKEN: undefined as string | undefined },
  };

  const reset = () => {
    state.tasks = [];
    state.countQueue = [];
    state.selectedIdBatches = [];
    state.concurrencyCap = 1;
    state.lastInflight = 0;
    state.selectAllStatuses = false;
    state.env.GITHUB_APP_TOKEN = undefined;
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
              const rows = state.selectAllStatuses
                ? state.tasks
                : state.tasks.filter((task) => task.status === 'queued');
              const selected = rows.slice(0, limit);
              const slots = Math.max(0, state.concurrencyCap - state.lastInflight);
              state.selectedIdBatches.push(selected.slice(0, slots).map((task) => task.id));
              return selected;
            }),
          };
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Partial<Task>) => ({
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
      })),
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

vi.mock('./db', () => ({ db: mocks.db }));
vi.mock('./adapters', () => ({ getAdapter: mocks.getAdapter }));
vi.mock('./env', () => ({ env: mocks.state.env }));
vi.mock('./agents-md', () => ({ fetchAgentsMd: mocks.fetchAgentsMd }));
vi.mock('./memory', () => ({
  formatMemoriesForPrompt: mocks.formatMemoriesForPrompt,
  getRelevantMemories: mocks.getRelevantMemories,
}));
vi.mock('./skill-loader', () => ({ getSkill: mocks.getSkill }));

import { claimNextBatch, dispatchOne, INFLIGHT_STATUSES } from './dispatcher';
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
    dependsOnIds: null,
    status: 'queued',
    sessionId: null,
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

async function claim(overrides: Partial<Mission> = {}): Promise<Task[]> {
  const currentMission = mission(overrides);
  mocks.state.concurrencyCap = currentMission.concurrencyCap;
  return claimNextBatch(currentMission);
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
});
