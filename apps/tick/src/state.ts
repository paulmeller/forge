import type { TaskStatus } from '@forge/db';

import type { BackendEvent } from './adapters/types';

/**
 * Task state machine (pure).
 *
 * One event in, zero or one transitions out. The poller runs this for
 * every new backend event and applies the returned delta to the task row.
 *
 * We keep it intentionally sparse: only the transitions Phase 1 drives
 * explicitly. Events that are informational (spans, thinking, tool calls
 * we don't react to) fall through with no transition — they still land
 * in the Ledger but don't move the task.
 */
export type StateTransition = {
  status?: TaskStatus;
  prUrl?: string | null;
  prNumber?: number | null;
  costTokensDelta?: number;
  lastError?: string | null;
  /** Set true when the transition should stamp completedAt. */
  completed?: boolean;
  /** True when this transition is a completed agent turn (running → turn_ended). */
  turnCompleted?: boolean;
};

export function transition(current: TaskStatus, event: BackendEvent): StateTransition | null {
  switch (event.type) {
    case 'session.status_running':
      if (current === 'dispatching' || current === 'turn_ended') {
        return { status: 'running' };
      }
      return null;

    case 'session.status_idle': {
      const stopType = readStopReasonType(event);
      // requires_action is a transient idle — the agent is waiting on us to
      // provide a tool result or confirmation. Don't treat it as turn-ended.
      if (stopType === 'requires_action') return null;
      if (current === 'running') return { status: 'turn_ended', turnCompleted: true };
      return null;
    }

    case 'session.status_terminated':
      // Terminated without a PR → abandoned; with a PR → let CI path handle it.
      if (current === 'awaiting_ci' || current === 'awaiting_review' || current === 'merged') {
        return null;
      }
      return { status: 'abandoned', completed: true };

    case 'session.error':
      return {
        status: 'failed',
        lastError: readErrorMessage(event) ?? 'session error',
        completed: true,
      };

    case 'agent.mcp_tool_result': {
      // Only transition on create_pull_request results, not read operations.
      // pull_request_read also returns PR URLs but shouldn't trigger awaiting_ci.
      const toolName = (event.raw as { mcp_tool_use_name?: string }).mcp_tool_use_name;
      const isCreate = !toolName || toolName === 'create_pull_request';
      if (!isCreate) return null;

      const pr = extractPullRequest(event);
      if (pr) {
        return {
          status: 'awaiting_ci',
          prUrl: pr.url,
          prNumber: pr.number,
        };
      }
      return null;
    }

    case 'span.model_request_end': {
      const usage = readModelUsage(event);
      if (!usage) return null;
      const delta =
        (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      return delta > 0 ? { costTokensDelta: delta } : null;
    }

    default:
      return null;
  }
}

function readStopReasonType(event: BackendEvent): string | undefined {
  const raw = event.raw;
  const stop = (raw as { stop_reason?: { type?: string } }).stop_reason;
  return stop?.type;
}

function readErrorMessage(event: BackendEvent): string | null {
  const raw = event.raw as { message?: string; error?: { message?: string } };
  return raw.message ?? raw.error?.message ?? null;
}

function readModelUsage(event: BackendEvent): Record<string, number> | null {
  const usage = (event.raw as { model_usage?: Record<string, number> }).model_usage;
  return usage ?? null;
}

type PullRequestInfo = { url: string; number: number };
const PR_URL_RE = /https:\/\/github\.com\/[^/\s"']+\/[^/\s"']+\/pull\/(\d+)/;

function extractPullRequest(event: BackendEvent): PullRequestInfo | null {
  const raw = event.raw as {
    content?: Array<{ type?: string; text?: string }>;
    result?: unknown;
  };
  // Walk every string we can find and pull the first GitHub PR URL.
  const candidates: string[] = [];

  if (Array.isArray(raw.content)) {
    for (const block of raw.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        candidates.push(block.text);
      }
    }
  }
  if (typeof raw.result === 'string') candidates.push(raw.result);
  if (raw.result && typeof raw.result === 'object') {
    try {
      candidates.push(JSON.stringify(raw.result));
    } catch {
      /* unserializable — ignore */
    }
  }

  for (const text of candidates) {
    const m = PR_URL_RE.exec(text);
    if (m) {
      const url = m[0];
      const number = Number(m[1]);
      if (Number.isFinite(number)) return { url, number };
    }
  }
  return null;
}
