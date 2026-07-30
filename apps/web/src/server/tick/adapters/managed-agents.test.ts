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

describe('ManagedAgentsAdapter getAgentInstructions', () => {
  // Issue #67: the agent's own `system` field (not anything under sessions)
  // is what dispatch-time contract checking reads.
  it('reads the system field off the agent record', async () => {
    const retrieve = vi.fn(async (_id: string) => ({ system: 'always open a pull request' }));
    const adapter = new ManagedAgentsAdapter({
      apiKey: 'k',
      environmentId: 'env_1',
      client: { beta: { agents: { retrieve } } } as never,
    });

    await expect(adapter.getAgentInstructions('agent_1')).resolves.toBe(
      'always open a pull request',
    );
    expect(retrieve).toHaveBeenCalledWith('agent_1');
  });

  it('returns null when the agent has no system prompt configured', async () => {
    const adapter = new ManagedAgentsAdapter({
      apiKey: 'k',
      environmentId: 'env_1',
      client: { beta: { agents: { retrieve: vi.fn(async () => ({})) } } } as never,
    });

    await expect(adapter.getAgentInstructions('agent_1')).resolves.toBeNull();
  });
});

describe('ManagedAgentsAdapter createSession provisioning failures', () => {
  // A session that dies while provisioning does not fail on create — it fails on the first
  // sendTurn, with a downstream `400 session is terminated`. That message is true and useless.
  // The engine has already written the real, actionable reason into the session's event log.
  function failingSendClient(events: unknown[]) {
    return {
      beta: {
        sessions: {
          create: vi.fn(async () => ({ id: 'sesn_dead' })),
          retrieve: vi.fn(async () => ({ id: 'sesn_dead', status: 'terminated' })),
          events: {
            send: vi.fn(async () => {
              throw new Error('400 session is terminated');
            }),
            list: vi.fn(async () => ({ data: events })),
          },
        },
      },
    } as unknown as import('@anthropic-ai/sdk').default;
  }

  const REAL_REASON =
    'network header transform requested but the sandbox/harness cannot TLS-terminate + trust the session CA — refusing to run (fail-closed)';

  it('surfaces the engine session.error instead of the generic "session is terminated"', async () => {
    const adapter = new ManagedAgentsAdapter({
      apiKey: 'k',
      environmentId: 'env_1',
      client: failingSendClient([
        { id: 'evt_1', type: 'session.status_running' },
        { id: 'evt_2', type: 'session.error', error: { type: 'egress_error', message: REAL_REASON } },
      ]),
    });

    await expect(adapter.createSession(input)).rejects.toThrow(REAL_REASON);
  });

  it('names the failing session and preserves the original error as cause', async () => {
    const adapter = new ManagedAgentsAdapter({
      apiKey: 'k',
      environmentId: 'env_1',
      client: failingSendClient([
        { id: 'evt_1', type: 'session.error', error: { type: 'egress_error', message: REAL_REASON } },
      ]),
    });

    let err: Error | undefined;
    try {
      await adapter.createSession(input);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('sesn_dead');
    expect((err!.cause as Error).message).toBe('400 session is terminated');
  });

  it('propagates the original error untouched when there is no session.error to report', async () => {
    const adapter = new ManagedAgentsAdapter({
      apiKey: 'k',
      environmentId: 'env_1',
      client: failingSendClient([{ id: 'evt_1', type: 'session.status_running' }]),
    });

    // No enrichment available — the caller must still see the real (if generic) failure,
    // not a swallowed or reworded one.
    await expect(adapter.createSession(input)).rejects.toThrow('400 session is terminated');
  });

  it('does not mask the original error when the diagnostic lookup itself fails', async () => {
    const client = {
      beta: {
        sessions: {
          create: vi.fn(async () => ({ id: 'sesn_dead' })),
          events: {
            send: vi.fn(async () => {
              throw new Error('400 session is terminated');
            }),
            list: vi.fn(async () => {
              throw new Error('events list exploded');
            }),
          },
        },
      },
    } as unknown as import('@anthropic-ai/sdk').default;
    const adapter = new ManagedAgentsAdapter({ apiKey: 'k', environmentId: 'env_1', client });

    await expect(adapter.createSession(input)).rejects.toThrow('400 session is terminated');
  });
});
