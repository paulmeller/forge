import Anthropic from '@anthropic-ai/sdk';

import type {
  BackendAdapter,
  BackendEvent,
  CreateSessionInput,
  CreateSessionResult,
  GetSessionResult,
  ListEventsInput,
  ListEventsResult,
  SessionLifecycle,
} from './types';

type MaEvent = {
  id?: string;
  type?: string;
  processed_at?: string | null;
  [key: string]: unknown;
};

type MaSession = {
  id: string;
  status?: string;
  stop_reason?: { type?: string };
};

export type ManagedAgentsAdapterOptions = {
  apiKey: string;
  environmentId: string;
  client?: Anthropic;
};

export class ManagedAgentsAdapter implements BackendAdapter {
  readonly kind = 'managed-agents' as const;
  private readonly client: Anthropic;
  private readonly environmentId: string;

  constructor(opts: ManagedAgentsAdapterOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.environmentId = opts.environmentId;
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const session = await this.client.beta.sessions.create({
      agent: input.agentId,
      environment_id: this.environmentId,
      title: `forge: ${input.repoUrl}`,
      resources: [
        {
          type: 'github_repository',
          url: input.repoUrl,
          authorization_token: input.repoCloneToken,
          checkout: { type: 'branch', name: input.baseBranch },
        },
      ],
      ...(input.githubMcpVaultId ? { vault_ids: [input.githubMcpVaultId] } : {}),
    } as never);

    await this.sendTurn(session.id, input.prompt);
    return { sessionId: session.id };
  }

  async sendTurn(sessionId: string, text: string): Promise<void> {
    await this.client.beta.sessions.events.send(sessionId, {
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text }],
        },
      ],
    } as never);
  }

  async listEvents(input: ListEventsInput): Promise<ListEventsResult> {
    const page = await this.client.beta.sessions.events.list(input.sessionId);
    const all = (page.data ?? []) as MaEvent[];

    let slice = all;
    if (input.afterEventId) {
      const idx = all.findIndex((e) => e.id === input.afterEventId);
      slice = idx >= 0 ? all.slice(idx + 1) : all;
    }

    const events: BackendEvent[] = slice
      .filter((e): e is MaEvent & { id: string; type: string } => !!e.id && !!e.type)
      .map((e) => ({
        id: e.id,
        type: e.type,
        processedAt: e.processed_at ? new Date(e.processed_at) : null,
        raw: e as Record<string, unknown>,
      }));

    const latest = events.at(-1);
    return {
      events,
      latestEventId: latest?.id,
      // Events.list pages are up to 1000; treat anything less as "no more".
      hasMore: all.length >= 1000,
    };
  }

  async getSession(sessionId: string): Promise<GetSessionResult> {
    const session = (await this.client.beta.sessions.retrieve(sessionId)) as MaSession;
    return {
      sessionId,
      status: normalizeStatus(session.status),
      stopReasonType: session.stop_reason?.type,
    };
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.client.beta.sessions.events.send(sessionId, {
      events: [{ type: 'user.interrupt' }],
    } as never);
  }

  async confirmToolUse(
    sessionId: string,
    toolUseEventId: string,
    decision: { result: 'allow' } | { result: 'deny'; denyMessage?: string },
  ): Promise<void> {
    const event: Record<string, unknown> = {
      type: 'user.tool_confirmation',
      tool_use_id: toolUseEventId,
      result: decision.result,
    };
    if (decision.result === 'deny' && decision.denyMessage) {
      event.deny_message = decision.denyMessage;
    }
    await this.client.beta.sessions.events.send(sessionId, {
      events: [event],
    } as never);
  }
}

function normalizeStatus(s: string | undefined): SessionLifecycle {
  switch (s) {
    case 'running':
      return 'running';
    case 'rescheduling':
      return 'rescheduling';
    case 'terminated':
      return 'terminated';
    case 'idle':
    default:
      return 'idle';
  }
}
