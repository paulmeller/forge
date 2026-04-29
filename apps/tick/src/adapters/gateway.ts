import type {
  BackendAdapter,
  BackendEvent,
  CreateSessionInput,
  CreateSessionResult,
  GetSessionResult,
  ListEventsInput,
  ListEventsResult,
  SessionLifecycle,
  ToolConfirmationDecision,
} from './types';

export type GatewayAdapterOptions = {
  baseUrl: string;
  apiKey: string;
  environmentId?: string;
};

type GatewayEvent = {
  id?: string;
  type?: string;
  processed_at?: string | null;
  [key: string]: unknown;
};

type GatewaySession = {
  id: string;
  status?: string;
  stop_reason?: { type?: string } | null;
};

/**
 * AgentStep Gateway adapter.
 *
 * The gateway exposes the same /v1/sessions/* surface as Anthropic Managed
 * Agents (it's an open-source drop-in replacement). This adapter is plain
 * HTTP — no SDK dependency, just fetch against the OpenAPI surface at
 * https://www.agentstep.com/v1/openapi.json.
 */
export class GatewayAdapter implements BackendAdapter {
  readonly kind = 'gateway' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly environmentId: string;

  constructor(opts: GatewayAdapterOptions) {
    // Strip trailing slash for consistent path joining
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.environmentId = opts.environmentId ?? 'default';
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const body: Record<string, unknown> = {
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
    };
    if (input.githubMcpVaultId) {
      body.vault_ids = [input.githubMcpVaultId];
    }

    const session = await this.request<GatewaySession>('POST', '/v1/sessions', body);

    // Send the initial prompt as a follow-up turn (same pattern as MA adapter)
    await this.sendTurn(session.id, input.prompt);

    return { sessionId: session.id };
  }

  async sendTurn(sessionId: string, text: string): Promise<void> {
    await this.request('POST', `/v1/sessions/${sessionId}/events`, {
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text }],
        },
      ],
    });
  }

  async listEvents(input: ListEventsInput): Promise<ListEventsResult> {
    const params = new URLSearchParams({ order: 'asc' });
    if (input.afterEventId) {
      // The gateway uses `after_seq` (integer) for cursor pagination.
      // However the event IDs from the gateway contain a sequence number.
      // We pass the event ID and let the gateway resolve it — the gateway
      // also accepts `after_id` as an alternative cursor.
      params.set('after_id', input.afterEventId);
    }

    const data = await this.request<{ data: GatewayEvent[]; next_page?: string | null }>(
      'GET',
      `/v1/sessions/${input.sessionId}/events?${params.toString()}`,
    );

    const rawEvents = data.data ?? [];
    const events: BackendEvent[] = rawEvents
      .filter((e): e is GatewayEvent & { id: string; type: string } => !!e.id && !!e.type)
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
      hasMore: !!data.next_page,
    };
  }

  async getSession(sessionId: string): Promise<GetSessionResult> {
    const session = await this.request<GatewaySession>('GET', `/v1/sessions/${sessionId}`);
    return {
      sessionId,
      status: normalizeStatus(session.status),
      stopReasonType: session.stop_reason?.type,
    };
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.request('POST', `/v1/sessions/${sessionId}/events`, {
      events: [{ type: 'user.interrupt' }],
    });
  }

  async confirmToolUse(
    sessionId: string,
    toolUseEventId: string,
    decision: ToolConfirmationDecision,
  ): Promise<void> {
    const event: Record<string, unknown> = {
      type: 'user.tool_confirmation',
      tool_use_id: toolUseEventId,
      result: decision.result,
    };
    if (decision.result === 'deny' && decision.denyMessage) {
      event.deny_message = decision.denyMessage;
    }
    await this.request('POST', `/v1/sessions/${sessionId}/events`, {
      events: [event],
    });
  }

  // ── HTTP plumbing ─────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'accept': 'application/json',
    };
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GatewayApiError(res.status, method, path, text);
    }

    return res.json() as Promise<T>;
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

export class GatewayApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Gateway ${method} ${path} → ${status}: ${body.slice(0, 200)}`);
    this.name = 'GatewayApiError';
  }
}
