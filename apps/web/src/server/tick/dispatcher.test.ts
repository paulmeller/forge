import type { Mission, Task } from '@forge/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const inflightStatuses = [
    'dispatching',
    'running',
    'turn_ended',
    'awaiting_ci',
    'awaiting_verify',
    'awaiting_ai_review',
    'ready_to_merge',
    'needs_human',
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
    insertedLedgerEvents: [] as Array<Record<string, unknown>>,
    env: {
      GITHUB_APP_TOKEN: undefined as string | undefined,
      FORGE_GIT_AUTHOR_NAME: 'Forge Agent',
      FORGE_GIT_AUTHOR_EMAIL: 'forge-agent@users.noreply.github.com',
      AGENT_CONTRACT_BLOCK: false,
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
    state.insertedLedgerEvents = [];
    state.env.GITHUB_APP_TOKEN = undefined;
    state.env.FORGE_GIT_AUTHOR_NAME = 'Forge Agent';
    state.env.FORGE_GIT_AUTHOR_EMAIL = 'forge-agent@users.noreply.github.com';
    state.env.AGENT_CONTRACT_BLOCK = false;
  };

  const adapter = {
    kind: 'managed-agents',
    createSession: vi.fn(),
    sendTurn: vi.fn(),
    listEvents: vi.fn(),
    getSession: vi.fn(),
    cancelSession: vi.fn(),
    confirmToolUse: vi.fn(),
    // Defaults to "no instructions configured" so existing dispatchOne tests
    // (none of which are about #67) see zero contract violations.
    getAgentInstructions: vi.fn(async (): Promise<string | null> => null),
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
    insert: vi.fn(() => ({
      values: vi.fn(async (row: Record<string, unknown>) => {
        // Record every ledger row inserted so tests can assert on eventType
        // rather than just call count — dispatchOne always inserts a
        // `dispatcher.dispatched` event on success, independent of #67's
        // contract check.
        state.insertedLedgerEvents.push(row);
      }),
    })),
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
// Keep the module's real exports (AdapterNotImplementedError, types) — only
// getAdapter itself needs to be faked.
vi.mock('./adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./adapters')>();
  return { ...actual, getAdapter: mocks.getAdapter };
});
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

import { AdapterNotImplementedError } from './adapters';
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
    githubDeliveryId: null,
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
    escalationReason: null,
    reviewDecision: null,
    approvedBy: null,
    approvedHeadSha: null,
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
  // vi.clearAllMocks() clears call history but not configured resolved
  // values, so a mockResolvedValue set by one test would otherwise leak
  // into every test declared after it. Restore the default here.
  mocks.fetchAgentsMd.mockResolvedValue({ content: '', file: null, truncated: false });
  mocks.adapter.getAgentInstructions.mockResolvedValue(null);
});

describe('INFLIGHT_STATUSES', () => {
  it('includes every active execution state', () => {
    expect(INFLIGHT_STATUSES).toEqual([
      'dispatching',
      'running',
      'turn_ended',
      'awaiting_ci',
      'awaiting_verify',
      'awaiting_ai_review',
      'ready_to_merge',
      'needs_human',
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

  it('does not put git identity setup in the prompt — the sandbox provisions it', async () => {
    // Git identity used to be prepended as a "run git config first" instruction,
    // which the agent had to remember to execute. The self-hosted Managed Agents
    // sandbox now sets it during provisioning, so the prompt must not carry it.
    mocks.state.env.GITHUB_APP_TOKEN = 'ghp_test';
    mocks.adapter.createSession.mockResolvedValue({ sessionId: 'ses_1' });

    await dispatchOne(mission(), task('t1'));

    const { prompt } = mocks.adapter.createSession.mock.calls[0]![0];
    expect(prompt).not.toContain('git config');
  });

  it('exposes the Forge-assigned branch to the goal template', async () => {
    // The agent cannot push to a name it was never told. This is the other
    // half of Forge owning the branch: Forge names it AND says so.
    mocks.state.env.GITHUB_APP_TOKEN = 'ghp_test';
    mocks.adapter.createSession.mockResolvedValue({ sessionId: 'ses_1' });
    mocks.fetchAgentsMd.mockResolvedValue({
      content: 'Push to: {{forge_branch}}',
      file: null,
      truncated: false,
    });

    await dispatchOne(mission(), task('t1'));

    const { prompt } = mocks.adapter.createSession.mock.calls[0]![0];
    expect(prompt).toContain('forge/t1');
  });

  it("does not blank a target repo's own template text in AGENTS.md", async () => {
    // AGENTS.md is fetched live from the repository the task targets, so it
    // may legitimately contain unrelated {{word}} text (Handlebars/Jinja
    // examples, docs about templating). Only Forge's own vars — forge_branch —
    // may be substituted; everything else must survive untouched.
    mocks.state.env.GITHUB_APP_TOKEN = 'ghp_test';
    mocks.fetchAgentsMd.mockResolvedValue({
      content: 'Push to {{forge_branch}}. Handlebars example: {{user}}.',
      file: null,
      truncated: false,
    });
    mocks.adapter.createSession.mockResolvedValue({ sessionId: 'ses_1' });

    await dispatchOne(mission(), task('t1'));

    const { prompt } = mocks.adapter.createSession.mock.calls[0]![0];
    expect(prompt).toContain('forge/t1'); // Forge's var resolved
    expect(prompt).toContain('{{user}}'); // the repo's own text survived
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

describe('dispatchOne — #67 agent contract check', () => {
  beforeEach(() => {
    mocks.state.env.GITHUB_APP_TOKEN = 'ghp_test';
    mocks.adapter.createSession.mockResolvedValue({ sessionId: 'ses_1' });
  });

  it('writes a dispatch.contract_warning ledger event when the agent instructions violate the contract', async () => {
    mocks.adapter.getAgentInstructions.mockResolvedValue('Never push your work.');

    await dispatchOne(mission(), task('t1'));

    const warning = mocks.state.insertedLedgerEvents.find(
      (row) => row.eventType === 'dispatch.contract_warning',
    );
    expect(warning).toBeDefined();
    expect((warning!.payload as { violations: unknown[] }).violations.length).toBeGreaterThan(0);
    // dispatch still proceeds — the warning is non-fatal by default.
    expect(mocks.adapter.createSession).toHaveBeenCalled();
  });

  it('does not write a contract_warning ledger event when the agent instructions are clean', async () => {
    mocks.adapter.getAgentInstructions.mockResolvedValue('Commit and push your work.');

    await dispatchOne(mission(), task('t1'));

    expect(
      mocks.state.insertedLedgerEvents.some((row) => row.eventType === 'dispatch.contract_warning'),
    ).toBe(false);
  });

  it('treats AdapterNotImplementedError as unknown, not a violation — dispatch proceeds silently', async () => {
    mocks.adapter.getAgentInstructions.mockRejectedValue(
      new AdapterNotImplementedError('gemini-managed-agents', 'getAgentInstructions'),
    );

    await dispatchOne(mission(), task('t1'));

    expect(
      mocks.state.insertedLedgerEvents.some((row) => row.eventType === 'dispatch.contract_warning'),
    ).toBe(false);
    expect(mocks.adapter.createSession).toHaveBeenCalled();
  });

  it('does not fail dispatch when fetching agent instructions throws for another reason', async () => {
    mocks.adapter.getAgentInstructions.mockRejectedValue(new Error('network blip'));

    await expect(dispatchOne(mission(), task('t1'))).resolves.toBeUndefined();
    expect(mocks.adapter.createSession).toHaveBeenCalled();
  });

  it('refuses to dispatch when AGENT_CONTRACT_BLOCK is opted in and a violation is found', async () => {
    mocks.state.env.AGENT_CONTRACT_BLOCK = true;
    mocks.adapter.getAgentInstructions.mockResolvedValue('Never push your work.');

    await expect(dispatchOne(mission(), task('t1'))).rejects.toThrow(/violate the dispatch contract/);

    expect(mocks.adapter.createSession).not.toHaveBeenCalled();
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
