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
  // Append-only per-session event log — see the design note above this task.
  // Never rebuilt or reordered; each poll only ever pushes newly-discovered items.
  private readonly eventLog = new Map<string, BackendEvent[]>();
  // How many of interaction.steps[] have already been translated into an
  // event, per session — steps are only ever appended by Gemini, so this is
  // a plain "resume from here" count, not a set of seen ids.
  private readonly processedStepCount = new Map<string, number>();
  // Whether the one-time terminal status event has already been appended.
  private readonly terminalEmitted = new Set<string>();
  // Last cumulative usage totals seen, for deciding whether this poll
  // warrants appending ONE new usage-delta event. Once appended, a usage
  // event's delta value is fixed forever — it is never recomputed later.
  private readonly lastSeenUsage = new Map<string, { input: number; output: number }>();

  constructor(opts: GeminiManagedAgentsAdapterOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com';
  }

  /**
   * Which physical Gemini interaction to act on. Precedence: the caller's
   * persisted ref (authoritative, survives restarts) → this instance's cache
   * (fast path while warm) → the original sessionId (last resort, only for
   * tasks created before backendSessionRef existed).
   */
  private resolvePhysicalId(sessionId: string, backendSessionRef?: string | null): string {
    return backendSessionRef ?? this.latestInteractionId.get(sessionId) ?? sessionId;
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

  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const physicalId = this.resolvePhysicalId(input.sessionId, input.backendSessionRef);
    const interaction = await this.request<GeminiInteraction>('POST', '/v1beta/interactions', {
      model: this.model,
      background: true,
      previous_interaction_id: physicalId,
      input: input.text,
    });
    this.latestInteractionId.set(input.sessionId, interaction.id);
    return { backendSessionRef: interaction.id };
  }

  async listEvents(input: ListEventsInput): Promise<ListEventsResult> {
    const physicalId = this.resolvePhysicalId(input.sessionId, input.backendSessionRef);
    const interaction = await this.request<GeminiInteraction>(
      'GET',
      `/v1beta/interactions/${physicalId}`,
    );

    const log = this.eventLog.get(input.sessionId) ?? [];
    if (log.length === 0) {
      log.push({
        id: `${input.sessionId}:status:running`,
        type: 'session.status_running',
        processedAt: null,
        raw: {},
      });
    }

    const allSteps = interaction.steps ?? [];
    const processedCount = this.processedStepCount.get(input.sessionId) ?? 0;
    for (let i = processedCount; i < allSteps.length; i++) {
      const step = allSteps[i]!;
      // Index-based, not id/call_id-based: a code_execution_call and its
      // paired code_execution_result share the same call_id, so keying by
      // that would collide the two into the same synthetic event id.
      const eventId = `${input.sessionId}:step:${i}`;
      const type = step.type as string | undefined;
      if (type === 'thought') {
        log.push({ id: eventId, type: 'agent.thinking', processedAt: null, raw: step });
      } else if (type === 'model_output') {
        log.push({ id: eventId, type: 'agent.message', processedAt: null, raw: step });
      } else if (type === 'code_execution_call') {
        log.push({ id: eventId, type: 'agent.tool_use', processedAt: null, raw: step });
      } else if (type === 'code_execution_result') {
        log.push({ id: eventId, type: 'agent.tool_result', processedAt: null, raw: step });
      }
      // Unrecognized step types are skipped — informational-only, matching
      // state.ts's convention of letting unrecognized events fall through.
    }
    this.processedStepCount.set(input.sessionId, allSteps.length);

    if (!this.terminalEmitted.has(input.sessionId)) {
      const statusEvent = terminalStatusEvent(input.sessionId, interaction.status);
      if (statusEvent) {
        log.push(statusEvent);
        this.terminalEmitted.add(input.sessionId);
      }
    }

    const prevUsage = this.lastSeenUsage.get(input.sessionId) ?? { input: 0, output: 0 };
    const currentInput = interaction.usage?.total_input_tokens ?? 0;
    const currentOutput = interaction.usage?.total_output_tokens ?? 0;
    const inputDelta = Math.max(0, currentInput - prevUsage.input);
    const outputDelta = Math.max(0, currentOutput - prevUsage.output);
    if (inputDelta > 0 || outputDelta > 0) {
      // id uses the log's length at this moment — always higher than any
      // previous usage event's id, since the log only ever grows.
      log.push({
        id: `${input.sessionId}:usage:${log.length}`,
        type: 'span.model_request_end',
        processedAt: null,
        raw: { model_usage: { input_tokens: inputDelta, output_tokens: outputDelta } },
      });
      this.lastSeenUsage.set(input.sessionId, { input: currentInput, output: currentOutput });
    }

    this.eventLog.set(input.sessionId, log);

    let events = log;
    if (input.afterEventId) {
      const idx = log.findIndex((e) => e.id === input.afterEventId);
      events = idx >= 0 ? log.slice(idx + 1) : log;
    }

    const latest = events.at(-1);
    return { events, latestEventId: latest?.id ?? input.afterEventId, hasMore: false };
  }

  async getSession(sessionId: string, backendSessionRef?: string | null): Promise<GetSessionResult> {
    const physicalId = this.resolvePhysicalId(sessionId, backendSessionRef);
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

  async cancelSession(sessionId: string, backendSessionRef?: string | null): Promise<void> {
    const physicalId = this.resolvePhysicalId(sessionId, backendSessionRef);
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

function terminalStatusEvent(sessionId: string, status: string): BackendEvent | null {
  switch (status) {
    case 'completed':
      return {
        id: `${sessionId}:status:completed`,
        type: 'session.status_idle',
        processedAt: null,
        raw: { stop_reason: { type: 'end_turn' } },
      };
    case 'failed':
    case 'incomplete':
    case 'budget_exceeded':
      return {
        id: `${sessionId}:status:${status}`,
        type: 'session.error',
        processedAt: null,
        raw: { message: `gemini interaction ${status}` },
      };
    case 'requires_action':
      return {
        id: `${sessionId}:status:requires_action`,
        type: 'session.error',
        processedAt: null,
        raw: { message: 'unexpected requires_action: v1 attaches no tool that should produce this state' },
      };
    case 'cancelled':
      return { id: `${sessionId}:status:cancelled`, type: 'session.status_terminated', processedAt: null, raw: {} };
    default:
      return null; // queued / in_progress — not yet settled
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
