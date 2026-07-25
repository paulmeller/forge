import { isErrorLogEvent, type LogEventLike } from './session-log-format';

/** Splits a chronological ledger into events that need a human's attention
 *  (real errors, per `isErrorLogEvent`) and everything else. Used by the
 *  repo workspace's Run output column to lead with what's actually
 *  actionable instead of a flat scrolling stream. */
export function partitionLedgerByAttention<T extends LogEventLike>(
  ledger: T[],
): { attention: T[]; activity: T[] } {
  const attention: T[] = [];
  const activity: T[] = [];
  for (const event of ledger) {
    (isErrorLogEvent(event) ? attention : activity).push(event);
  }
  return { attention, activity };
}
