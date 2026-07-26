import type {
  BackendAdapter,
  CreateSessionInput,
  CreateSessionResult,
  GetSessionResult,
  ListEventsInput,
  ListEventsResult,
  SessionLifecycle,
  ToolConfirmationDecision,
} from './types';

export type GeminiManagedAgentsAdapterOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
};

export type GeminiInteraction = {
  id: string;
  status: string;
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
  };
  steps?: Array<Record<string, unknown>>;
};

function buildSetupInstructions(input: CreateSessionInput): string {
  return (
    'Setup — run this first, using the code execution tool:\n' +
    '1. Configure git to authenticate via header (the real token is injected\n' +
    '   transparently by the network proxy for requests to github.com — you will\n' +
    '   never see it and must not try to obtain or embed one yourself):\n' +
    '   git config --global http.https://github.com/.extraHeader "Authorization: Bearer placeholder"\n' +
    `2. Clone the repository and check out the base branch:\n` +
    `   git clone ${input.repoUrl} repo && cd repo && git checkout ${input.baseBranch}\n` +
    'Do all further work inside the `repo` directory.'
  );
}

/**
 * Gemini Interactions API adapter (https://ai.google.dev/api/interactions-api).
 *
 * Plain HTTP — no SDK dependency, same precedent as GatewayAdapter. Gemini has
 * no persistent multi-turn session id: every interaction (including follow-ups
 * chained via previous_interaction_id) gets a fresh id. Forge's task.sessionId
 * is set once at createSession and never changes, so this adapter tracks,
 * per logical session, which physical interaction id is currently "live" —
 * the one every other method should actually poll/act on.
 */
export class GeminiManagedAgentsAdapter implements BackendAdapter {
  readonly kind = 'gemini-managed-agents' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly latestInteractionId = new Map<string, string>();

  constructor(opts: GeminiManagedAgentsAdapterOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com';
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const body = {
      model: this.model,
      background: true,
      tools: [{ type: 'code_execution' }],
      environment: {
        type: 'remote',
        network: {
          allowlist: [
            { domain: 'github.com', transform: { Authorization: `Bearer ${input.repoCloneToken}` } },
            { domain: 'api.github.com', transform: { Authorization: `Bearer ${input.repoCloneToken}` } },
            { domain: '*' },
          ],
        },
      },
      input: `${buildSetupInstructions(input)}\n\n---\n\n${input.prompt}`,
    };

    const interaction = await this.request<GeminiInteraction>('POST', '/v1beta/interactions', body);
    this.latestInteractionId.set(interaction.id, interaction.id);
    return { sessionId: interaction.id };
  }

  async sendTurn(sessionId: string, text: string): Promise<void> {
    const physicalId = this.latestInteractionId.get(sessionId) ?? sessionId;
    const interaction = await this.request<GeminiInteraction>('POST', '/v1beta/interactions', {
      model: this.model,
      background: true,
      previous_interaction_id: physicalId,
      input: text,
    });
    this.latestInteractionId.set(sessionId, interaction.id);
  }

  async listEvents(_input: ListEventsInput): Promise<ListEventsResult> {
    // Replaced in Task 3 with the full status/step translation.
    return { events: [], hasMore: false };
  }

  async getSession(sessionId: string): Promise<GetSessionResult> {
    const physicalId = this.latestInteractionId.get(sessionId) ?? sessionId;
    const interaction = await this.request<GeminiInteraction>(
      'GET',
      `/v1beta/interactions/${physicalId}`,
    );
    return {
      sessionId,
      status: normalizeStatus(interaction.status),
      stopReasonType: interaction.status === 'requires_action' ? 'requires_action' : undefined,
    };
  }

  async cancelSession(sessionId: string): Promise<void> {
    const physicalId = this.latestInteractionId.get(sessionId) ?? sessionId;
    await this.request('POST', `/v1beta/interactions/${physicalId}/cancel`);
  }

  async confirmToolUse(
    _sessionId: string,
    _toolUseEventId: string,
    _decision: ToolConfirmationDecision,
  ): Promise<void> {
    throw new Error(
      'GeminiManagedAgentsAdapter: confirmToolUse should be unreachable — v1 never attaches a tool requiring confirmation',
    );
  }

  // ── HTTP plumbing ─────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'x-goog-api-key': this.apiKey };
    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GeminiApiError(res.status, method, path, text);
    }

    return res.json() as Promise<T>;
  }
}

function normalizeStatus(status: string): SessionLifecycle {
  switch (status) {
    case 'queued':
    case 'in_progress':
      return 'running';
    case 'cancelled':
      return 'terminated';
    default:
      // completed / failed / incomplete / budget_exceeded / requires_action —
      // the turn is over one way or another; "idle" means "ball is in our court".
      return 'idle';
  }
}

export class GeminiApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Gemini ${method} ${path} → ${status}: ${body.slice(0, 200)}`);
    this.name = 'GeminiApiError';
  }
}
