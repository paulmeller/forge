import { describe, expect, it, vi } from 'vitest';

import { ManagedAgentsAdapter } from './managed-agents';

function fakeClient(createImpl: (params: unknown) => Promise<{ id: string }>) {
  return {
    beta: {
      sessions: {
        create: vi.fn(createImpl),
        events: { send: vi.fn(async () => undefined) },
      },
    },
  } as unknown as import('@anthropic-ai/sdk').default;
}

const input = {
  agentId: 'agent_1',
  repoUrl: 'https://github.com/acme/api',
  repoCloneToken: 'tok',
  baseBranch: 'main',
  prompt: 'do it',
};

describe('ManagedAgentsAdapter createSession vault_ids', () => {
  it('sends no vault_ids when neither default nor mission vault is set', async () => {
    const create = vi.fn(async (_params: unknown) => ({ id: 'sesn_1' }));
    const adapter = new ManagedAgentsAdapter({
      apiKey: 'k',
      environmentId: 'env_1',
      client: fakeClient(create),
    });
    await adapter.createSession(input);
    const params = create.mock.calls[0]![0] as { vault_ids?: string[] };
    expect(params.vault_ids).toBeUndefined();
  });

  it('includes the default vault when set and no mission vault is provided', async () => {
    const create = vi.fn(async (_params: unknown) => ({ id: 'sesn_1' }));
    const adapter = new ManagedAgentsAdapter({
      apiKey: 'k',
      environmentId: 'env_1',
      defaultVaultId: 'vlt_default',
      client: fakeClient(create),
    });
    await adapter.createSession(input);
    const params = create.mock.calls[0]![0] as { vault_ids?: string[] };
    expect(params.vault_ids).toEqual(['vlt_default']);
  });

  it('includes both the default vault and a mission-specific vault', async () => {
    const create = vi.fn(async (_params: unknown) => ({ id: 'sesn_1' }));
    const adapter = new ManagedAgentsAdapter({
      apiKey: 'k',
      environmentId: 'env_1',
      defaultVaultId: 'vlt_default',
      client: fakeClient(create),
    });
    await adapter.createSession({ ...input, githubMcpVaultId: 'vlt_mission' });
    const params = create.mock.calls[0]![0] as { vault_ids?: string[] };
    expect(params.vault_ids).toEqual(['vlt_default', 'vlt_mission']);
  });

  it('includes only the mission vault when no default vault is configured', async () => {
    const create = vi.fn(async (_params: unknown) => ({ id: 'sesn_1' }));
    const adapter = new ManagedAgentsAdapter({
      apiKey: 'k',
      environmentId: 'env_1',
      client: fakeClient(create),
    });
    await adapter.createSession({ ...input, githubMcpVaultId: 'vlt_mission' });
    const params = create.mock.calls[0]![0] as { vault_ids?: string[] };
    expect(params.vault_ids).toEqual(['vlt_mission']);
  });
});
