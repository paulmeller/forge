/**
 * BackendAdapter — the seam between Forge's orchestration and the agent engine.
 *
 * Both `managed-agents` and `gateway` implement this same surface; callers
 * (dispatcher, poller, Gate) don't know which is underneath. Per PRD §7.9.
 */
export type BackendKind = 'managed-agents' | 'gateway';

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
  sendTurn(sessionId: string, text: string): Promise<void>;
  listEvents(input: ListEventsInput): Promise<ListEventsResult>;
  getSession(sessionId: string): Promise<GetSessionResult>;
  cancelSession(sessionId: string): Promise<void>;
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
