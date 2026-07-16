import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { Mission, NewMission } from '@forge/db';

import type { MissionDefaults } from './mission-defaults';

const DB_FILE = `/tmp/forge-workspace-mission-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
}
process.env.DATABASE_URL = `file:${DB_FILE}`;

let db: LibSQLDatabase<Record<string, unknown>>;
let client: { close: () => void };
let schema: typeof import('@forge/db');
let dbFindExistingWorkspaceMission: typeof import('./workspace-mission').dbFindExistingWorkspaceMission;
let getOrCreateWorkspaceMission: typeof import('./workspace-mission').getOrCreateWorkspaceMission;
let getOrCreateIssueMission: typeof import('./workspace-mission').getOrCreateIssueMission;

beforeAll(async () => {
  const dbMod = await import('./db');
  db = dbMod.db as unknown as LibSQLDatabase<Record<string, unknown>>;
  client = dbMod.client as unknown as { close: () => void };
  await migrate(dbMod.db, {
    migrationsFolder: resolve(__dirname, '../../../../packages/db/migrations'),
  });
  schema = await import('@forge/db');
  ({ dbFindExistingWorkspaceMission, getOrCreateWorkspaceMission, getOrCreateIssueMission } =
    await import('./workspace-mission'));
});

afterAll(() => {
  client.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_FILE + suffix)) rmSync(DB_FILE + suffix);
  }
});

async function insertMission(id: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  await db.insert(schema.missions).values({
    id,
    userId: 'user_1',
    name: 'Test mission',
    goal: 'test',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_1',
    plannerStrategy: 'rule-based',
    webhookSecret: 'secret',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

const defaults: MissionDefaults = {
  agentId: 'agent_abc',
  githubInstallationId: '123',
  githubVaultId: 'vault_abc',
  source: 'setup',
};

function fakeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'msn_existing',
    userId: 'usr_1',
    name: 'Issues — acme/api',
    goal: 'Triage open issues in acme/api',
    status: 'running',
    backend: 'managed-agents',
    agentId: 'agent_abc',
    plannerStrategy: 'triage',
    targetRepos: ['acme/api'],
    issueQuery: null,
    concurrencyCap: 5,
    budgetUsd: null,
    budgetTokens: null,
    budgetThresholdPct: 80,
    spentUsd: 0,
    spentTokens: 0,
    autoMergePolicy: null,
    webhookSecret: 'secret',
    githubInstallationId: '123',
    githubVaultId: 'vault_abc',
    skillId: null,
    aiReviewEnabled: false,
    budgetHardStopPct: 100,
    taskMaxTokens: null,
    taskMaxTurns: null,
    noProgressTokens: null,
    selfVerifyEnabled: false,
    workspaceRepo: 'acme/api',
    issueRef: null,
    parentMissionId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    ...over,
  } as Mission;
}

describe('dbFindExistingWorkspaceMission', () => {
  it('returns the container, not the newest issue leaf, when a repo has leaves', async () => {
    // Regression test for the bug where dbFindExistingWorkspaceMission's
    // WHERE clause only excluded terminal statuses, not issue leaves. Since
    // leaves share workspaceRepo with their container and are typically
    // non-terminal, ORDER BY createdAt DESC LIMIT 1 would pick the most
    // recently created leaf instead of the true container as soon as a repo
    // had any issue ever worked in it.
    const repo = 'paulmeller/leaf-vs-container';
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const leafId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await insertMission(containerId, {
      workspaceRepo: repo,
      issueRef: null,
      parentMissionId: null,
      status: 'running',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await insertMission(leafId, {
      workspaceRepo: repo,
      issueRef: `${repo}#4`,
      parentMissionId: containerId,
      status: 'running',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const found = await dbFindExistingWorkspaceMission('user_1', repo);

    expect(found?.id).toBe(containerId);
    expect(found?.id).not.toBe(leafId);
  });

  it('still finds a container correctly when it has no leaves yet', async () => {
    const repo = 'paulmeller/lonely-container';
    const containerId = `msn_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await insertMission(containerId, {
      workspaceRepo: repo,
      issueRef: null,
      parentMissionId: null,
      status: 'running',
    });

    const found = await dbFindExistingWorkspaceMission('user_1', repo);

    expect(found?.id).toBe(containerId);
  });
});

describe('getOrCreateWorkspaceMission', () => {
  it('returns the existing mission without inserting when one is found', async () => {
    const existing = fakeMission();
    const findExisting = vi.fn().mockResolvedValue(existing);
    const insertMission = vi.fn();

    const result = await getOrCreateWorkspaceMission('usr_1', 'acme/api', defaults, {
      findExisting,
      insertMission,
    });

    expect(result).toBe(existing);
    expect(findExisting).toHaveBeenCalledWith('usr_1', 'acme/api');
    expect(insertMission).not.toHaveBeenCalled();
  });

  it('inserts a new running mission scoped to the repo when none exists', async () => {
    const inserted = fakeMission({ id: 'msn_new' });
    const findExisting = vi.fn().mockResolvedValue(null);
    const insertMission = vi.fn().mockResolvedValue(inserted);

    const result = await getOrCreateWorkspaceMission('usr_1', 'acme/api', defaults, {
      findExisting,
      insertMission,
    });

    expect(result).toBe(inserted);
    expect(insertMission).toHaveBeenCalledTimes(1);
    const values = insertMission.mock.calls[0]![0] as NewMission;
    expect(values.workspaceRepo).toBe('acme/api');
    expect(values.targetRepos).toEqual(['acme/api']);
    expect(values.plannerStrategy).toBe('triage');
    expect(values.status).toBe('running');
    expect(values.agentId).toBe('agent_abc');
    expect(values.githubInstallationId).toBe('123');
    expect(values.githubVaultId).toBe('vault_abc');
    expect(values.budgetUsd).toBeNull();
    expect(values.name).toBe('Issues — acme/api');
    expect(values.goal).toContain('acme/api');
  });

  it('throws instead of inserting a mission when no agent is configured', async () => {
    const noAgentDefaults: MissionDefaults = { ...defaults, agentId: null, source: 'none' };
    const findExisting = vi.fn().mockResolvedValue(null);
    const insertMission = vi.fn();

    await expect(
      getOrCreateWorkspaceMission('usr_1', 'acme/api', noAgentDefaults, {
        findExisting,
        insertMission,
      }),
    ).rejects.toThrow(/no agent configured/i);

    expect(insertMission).not.toHaveBeenCalled();
  });
});

describe('getOrCreateIssueMission', () => {
  it('returns the existing active issue mission without touching the container or inserting', async () => {
    const existing = fakeMission({
      id: 'msn_issue_existing',
      issueRef: 'acme/api#42',
      parentMissionId: 'msn_container',
    });
    const findExistingIssue = vi.fn().mockResolvedValue(existing);
    const reopenMission = vi.fn();
    const getOrCreateContainer = vi.fn();
    const insertMission = vi.fn();

    const result = await getOrCreateIssueMission('usr_1', 'acme/api', 'acme/api#42', defaults, {
      findExistingIssue,
      reopenMission,
      getOrCreateContainer,
      insertMission,
    });

    expect(result).toBe(existing);
    expect(findExistingIssue).toHaveBeenCalledWith('usr_1', 'acme/api', 'acme/api#42');
    expect(getOrCreateContainer).not.toHaveBeenCalled();
    expect(insertMission).not.toHaveBeenCalled();
    expect(reopenMission).not.toHaveBeenCalled();
  });

  it('reopens a completed issue mission instead of creating a new one', async () => {
    const existing = fakeMission({
      id: 'msn_issue_done',
      status: 'completed',
      issueRef: 'acme/api#42',
    });
    const reopened = fakeMission({ id: 'msn_issue_done', status: 'running', issueRef: 'acme/api#42' });
    const findExistingIssue = vi.fn().mockResolvedValue(existing);
    const reopenMission = vi.fn().mockResolvedValue(reopened);
    const getOrCreateContainer = vi.fn();
    const insertMission = vi.fn();

    const result = await getOrCreateIssueMission('usr_1', 'acme/api', 'acme/api#42', defaults, {
      findExistingIssue,
      reopenMission,
      getOrCreateContainer,
      insertMission,
    });

    expect(result).toBe(reopened);
    expect(reopenMission).toHaveBeenCalledWith('msn_issue_done');
    expect(getOrCreateContainer).not.toHaveBeenCalled();
    expect(insertMission).not.toHaveBeenCalled();
  });

  it('reopens a cancelled issue mission the same way as completed', async () => {
    const existing = fakeMission({
      id: 'msn_issue_cancelled',
      status: 'cancelled',
      issueRef: 'acme/api#7',
    });
    const reopened = fakeMission({ id: 'msn_issue_cancelled', status: 'running', issueRef: 'acme/api#7' });
    const findExistingIssue = vi.fn().mockResolvedValue(existing);
    const reopenMission = vi.fn().mockResolvedValue(reopened);

    const result = await getOrCreateIssueMission('usr_1', 'acme/api', 'acme/api#7', defaults, {
      findExistingIssue,
      reopenMission,
      getOrCreateContainer: vi.fn(),
      insertMission: vi.fn(),
    });

    expect(result).toBe(reopened);
    expect(reopenMission).toHaveBeenCalledWith('msn_issue_cancelled');
  });

  it('creates the container then inserts a new leaf mission when none exists', async () => {
    const container = fakeMission({ id: 'msn_container', issueRef: null, parentMissionId: null });
    const inserted = fakeMission({
      id: 'msn_issue_new',
      issueRef: 'acme/api#99',
      parentMissionId: 'msn_container',
    });
    const findExistingIssue = vi.fn().mockResolvedValue(null);
    const getOrCreateContainer = vi.fn().mockResolvedValue(container);
    const insertMission = vi.fn().mockResolvedValue(inserted);

    const result = await getOrCreateIssueMission('usr_1', 'acme/api', 'acme/api#99', defaults, {
      findExistingIssue,
      reopenMission: vi.fn(),
      getOrCreateContainer,
      insertMission,
    });

    expect(result).toBe(inserted);
    expect(getOrCreateContainer).toHaveBeenCalledWith('usr_1', 'acme/api', defaults);
    expect(insertMission).toHaveBeenCalledTimes(1);
    const values = insertMission.mock.calls[0]![0] as NewMission;
    expect(values.parentMissionId).toBe('msn_container');
    expect(values.issueRef).toBe('acme/api#99');
    expect(values.workspaceRepo).toBe('acme/api');
    expect(values.status).toBe('running');
    expect(values.plannerStrategy).toBe('rule-based');
    expect(values.agentId).toBe('agent_abc');
  });

  it('throws instead of inserting a leaf mission when no agent is configured', async () => {
    const container = fakeMission({ id: 'msn_container' });
    const noAgentDefaults: MissionDefaults = { ...defaults, agentId: null, source: 'none' };
    const findExistingIssue = vi.fn().mockResolvedValue(null);
    const getOrCreateContainer = vi.fn().mockResolvedValue(container);
    const insertMission = vi.fn();

    await expect(
      getOrCreateIssueMission('usr_1', 'acme/api', 'acme/api#1', noAgentDefaults, {
        findExistingIssue,
        reopenMission: vi.fn(),
        getOrCreateContainer,
        insertMission,
      }),
    ).rejects.toThrow(/no agent configured/i);

    expect(insertMission).not.toHaveBeenCalled();
  });
});
