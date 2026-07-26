import { isErrorLogEvent, type LogEventLike } from './session-log-format';

/** A tool call that came back clean — concrete evidence the agent made forward
 *  progress, as opposed to an assistant message, which might just be the agent
 *  talking *about* a failure. */
function isSuccessfulToolResult(event: LogEventLike): boolean {
  return event.eventType === 'agent.tool_result' && !isErrorLogEvent(event);
}

/**
 * Splits a chronological ledger into events that need a human's attention and
 * everything else, for the repo workspace's Run output column.
 *
 * "Needs attention" is deliberately narrower than "is an error". Agents hit
 * non-zero exits constantly as a normal part of working — a missing dep, a
 * failing test they are about to fix — and then recover. Flagging all of them
 * meant a task that had already opened a green PR still showed a column of red
 * Blockers, which just trains the reader to ignore the tier.
 *
 * So an error only counts as unresolved if no tool call has succeeded *after*
 * it. Anything before the last successful tool result is history: the agent
 * demonstrably carried on. If nothing has ever succeeded, every error stands —
 * that run really is stuck.
 */
export function partitionLedgerByAttention<T extends LogEventLike>(
  ledger: T[],
): { attention: T[]; activity: T[] } {
  let lastSuccessIdx = -1;
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (isSuccessfulToolResult(ledger[i]!)) {
      lastSuccessIdx = i;
      break;
    }
  }

  const attention: T[] = [];
  const activity: T[] = [];
  ledger.forEach((event, i) => {
    (i > lastSuccessIdx && isErrorLogEvent(event) ? attention : activity).push(event);
  });
  return { attention, activity };
}
