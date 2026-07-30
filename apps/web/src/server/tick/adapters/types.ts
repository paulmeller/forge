/**
 * BackendAdapter — the seam between Forge's orchestration and the agent engine.
 *
 * Both `managed-agents` and `gateway` implement this same surface; callers
 * (dispatcher, poller, Gate) don't know which is underneath. Per PRD §7.9.
 */
export type BackendKind = 'managed-agents' | 'gateway' | 'gemini-managed-agents';

export type CreateSessionInput = {
  agentId: string;
  repoUrl: string;
  repoCloneToken: string;
  baseBranch: string;
  /** Optional. Vault holding the GitHub MCP OAuth credential; omit for missions that don't use MCP tools. */
  githubMcpVaultId?: string | null;
  /** Rendered user prompt to send as the first turn. */
  prompt: string;
};

export type CreateSessionResult = {
  sessionId: string;
};

export type SendTurnInput = {
  sessionId: string;
  text: string;
  /**
   * The backend's live session handle, when it differs from `sessionId`.
   * Gemini rotates its interaction id every turn; passing the persisted
   * value lets a cold instance target the correct one instead of falling
   * back to the original (already-finished) session.
   */
  backendSessionRef?: string | null;
};

export type SendTurnResult = {
  /** Set when this turn produced a new backend handle the caller must persist. */
  backendSessionRef?: string;
};

export type BackendEventKind =
  | 'user.message'
  | 'agent.message'
  | 'agent.thinking'
  | 'agent.tool_use'
  | 'agent.tool_result'
  | 'agent.mcp_tool_use'
  | 'agent.mcp_tool_result'
  | 'agent.custom_tool_use'
  | 'session.status_idle'
  | 'session.status_running'
  | 'session.status_rescheduled'
  | 'session.status_terminated'
  | 'session.error'
  | 'span.model_request_start'
  | 'span.model_request_end'
  | string;

export type BackendEvent = {
  id: string;
  type: BackendEventKind;
  processedAt: Date | null;
  raw: Record<string, unknown>;
};

export type ListEventsInput = {
  sessionId: string;
  /** Cursor — return events with id > this. Adapter decides the concrete pagination. */
  afterEventId?: string;
  /** See SendTurnInput.backendSessionRef. */
  backendSessionRef?: string | null;
};

export type ListEventsResult = {
  events: BackendEvent[];
  latestEventId?: string;
  /** True when the page we got matches page size and more events may exist. */
  hasMore: boolean;
};

export type SessionLifecycle = 'idle' | 'running' | 'rescheduling' | 'terminated';

export type GetSessionResult = {
  sessionId: string;
  status: SessionLifecycle;
  stopReasonType?: string;
};

export type ToolConfirmationDecision =
  | { result: 'allow' }
  | { result: 'deny'; denyMessage?: string };

export interface BackendAdapter {
  readonly kind: BackendKind;
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  sendTurn(input: SendTurnInput): Promise<SendTurnResult>;
  listEvents(input: ListEventsInput): Promise<ListEventsResult>;
  /**
   * Open the backend's raw SSE event stream for a session — the live run
   * console (the browser-facing `stream` route) relays this Response's
   * body straight through rather than parsing it, so the return type is
   * the fetch Response itself, not a parsed event list like listEvents.
   * Throws AdapterNotImplementedError when the backend has no equivalent
   * endpoint (gemini-managed-agents: the Interactions API has nothing to
   * stream from) — callers must treat that as "unavailable", not attempt
   * a fetch of their own against the wrong host.
   */
  streamEvents(sessionId: string): Promise<Response>;
  getSession(sessionId: string, backendSessionRef?: string | null): Promise<GetSessionResult>;
  /**
   * The backend agent's own configured instructions — its persistent system
   * prompt, independent of anything Forge composes into the per-task prompt
   * (AGENTS.md + goal). Dispatch checks this against the contract Forge
   * relies on (see server/tick/agent-contract.ts) — the agent record lives
   * outside Forge's control and has drifted out of step with it before
   * (#58/#66). Returns null when the backend reports no instructions are
   * configured for this agent — that's "none set", not "unknown".
   * Throws AdapterNotImplementedError when the backend has no concept of a
   * retrievable agent record at all (gemini-managed-agents) — callers must
   * treat that as "unknown", not a clean bill of health, same convention as
   * streamEvents.
   */
  getAgentInstructions(agentId: string): Promise<string | null>;
  cancelSession(sessionId: string, backendSessionRef?: string | null): Promise<void>;
  /**
   * Approve or deny an MCP / agent tool use that's blocking the session at
   * `session.status_idle` with `stop_reason.type='requires_action'`. The
   * `toolUseEventId` is the id of the agent.tool_use / agent.mcp_tool_use
   * event whose evaluated_permission was 'ask'.
   */
  confirmToolUse(
    sessionId: string,
    toolUseEventId: string,
    decision: ToolConfirmationDecision,
  ): Promise<void>;
}

export class AdapterNotImplementedError extends Error {
  constructor(adapter: BackendKind, op: string) {
    super(`${adapter} adapter does not implement ${op} yet`);
    this.name = 'AdapterNotImplementedError';
  }
}
