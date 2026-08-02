import Anthropic from '@anthropic-ai/sdk';

import type {
  BackendAdapter,
  BackendEvent,
  CreateSessionInput,
  CreateSessionResult,
  GetSessionResult,
  ListEventsInput,
  ListEventsResult,
  SendTurnInput,
  SendTurnResult,
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
  /**
   * Vault carrying the model-provider credential (CLAUDE_CODE_OAUTH_TOKEN /
   * ANTHROPIC_API_KEY) every session needs — attached alongside any
   * mission-specific vault (e.g. GitHub PR-creation) on every createSession.
   */
  defaultVaultId?: string;
  client?: Anthropic;
};

export class ManagedAgentsAdapter implements BackendAdapter {
  readonly kind = 'managed-agents' as const;
  private readonly client: Anthropic;
  private readonly environmentId: string;
  private readonly defaultVaultId?: string;

  constructor(opts: ManagedAgentsAdapterOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.environmentId = opts.environmentId;
    this.defaultVaultId = opts.defaultVaultId;
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const vaultIds = [this.defaultVaultId, input.githubMcpVaultId].filter(
      (id): id is string => !!id,
    );
    const session = await this.client.beta.sessions.create({
      agent: input.agentId,
      environment_id: this.environmentId,
      title: `forge: ${input.repoUrl}`,
      resources: [
        {
          type: 'github_repository',
          url: input.repoUrl,
          // Omitted when FORGE_NO_CLONE_TOKEN=true: a token on the resource makes
          // the engine derive a header-transform, which requires TLS-terminating
          // egress — supported only by the docker provider. On apple-container
          // (no termination yet, fail-closed) public repos clone tokenless and
          // push auth comes from a vault env credential + the provisioning-time
          // git credential helper instead.
          ...(process.env.FORGE_NO_CLONE_TOKEN === 'true' ? {} : { authorization_token: input.repoCloneToken }),
          checkout: { type: 'branch', name: input.baseBranch },
        },
      ],
      ...(vaultIds.length > 0 ? { vault_ids: vaultIds } : {}),
    } as never);

    // A session that dies during provisioning does not fail HERE — it fails on the first
    // sendTurn, as a downstream `400 session is terminated`. That message is true, generic,
    // and destroys the actual cause, which the engine has already written into the session's
    // own event log (see sessionFailureReason). Surface that instead.
    try {
      await this.sendTurn({ sessionId: session.id, text: input.prompt });
    } catch (err) {
      const reason = await this.sessionFailureReason(session.id);
      if (reason) {
        throw new Error(
          `managed-agents session ${session.id} failed during provisioning: ${reason}`,
          { cause: err },
        );
      }
      throw err;
    }
    return { sessionId: session.id };
  }

  /**
   * The reason the engine refused to run this session, read from its own event stream.
   *
   * The engine emits a precise, actionable `session.error` when provisioning fails — e.g.
   * "network header transform requested but the sandbox/harness cannot TLS-terminate + trust
   * the session CA — refusing to run (fail-closed)", which names both the cause and the fix.
   * Without this lookup the caller only ever sees the generic `session is terminated` from the
   * next call, and the real reason is sitting unread in the event log. Returns null when there
   * is no session.error to report, so the original error propagates untouched.
   *
   * Never throws: a diagnostics lookup must not mask the failure it is trying to explain.
   */
  private async sessionFailureReason(sessionId: string): Promise<string | null> {
    try {
      const page = await this.client.beta.sessions.events.list(sessionId);
      for (const e of (page.data ?? []) as MaEvent[]) {
        if (e.type !== 'session.error') continue;
        const error = e.error as { type?: string; message?: string } | undefined;
        if (!error?.message) continue;
        return error.type ? `${error.type}: ${error.message}` : error.message;
      }
    } catch {
      // Swallow: the caller's original error is more important than this enrichment.
    }
    return null;
  }

  // backendSessionRef is unused: Managed Agents session ids are stable for the
  // life of the session, so there is never a rotated handle to track.
  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    await this.client.beta.sessions.events.send(input.sessionId, {
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: input.text }],
        },
      ],
    } as never);
    return {};
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

  /**
   * The SDK has no `sessions.events.stream()` method, so this is a plain
   * fetch — but built from the same client the rest of this adapter uses
   * (its `baseURL`/`apiKey`), so a self-hosted engine reached via
   * ANTHROPIC_BASE_URL (see adapters/index.ts) is honored here too instead
   * of silently defaulting back to api.anthropic.com.
   */
  async streamEvents(sessionId: string): Promise<Response> {
    return fetch(`${this.client.baseURL}/v1/sessions/${sessionId}/events/stream`, {
      headers: {
        'x-api-key': this.client.apiKey ?? '',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'managed-agents-2026-04-01',
      },
    });
  }

  async getSession(sessionId: string, _backendSessionRef?: string | null): Promise<GetSessionResult> {
    const session = (await this.client.beta.sessions.retrieve(sessionId)) as MaSession;
    return {
      sessionId,
      status: normalizeStatus(session.status),
      stopReasonType: session.stop_reason?.type,
    };
  }

  // Agents live on their own beta surface (`/v1/agents/{id}`), not under
  // sessions — cast the same way createSession does for beta-surface shapes
  // the installed SDK types may not yet describe.
  async getAgentInstructions(agentId: string): Promise<string | null> {
    const agents = (
      this.client.beta as unknown as {
        agents: { retrieve: (id: string) => Promise<{ system?: string | null }> };
      }
    ).agents;
    const agent = await agents.retrieve(agentId);
    return agent.system ?? null;
  }

  async cancelSession(sessionId: string, _backendSessionRef?: string | null): Promise<void> {
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
