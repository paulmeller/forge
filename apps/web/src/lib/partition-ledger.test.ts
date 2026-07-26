import { describe, expect, it } from 'vitest';

import { partitionLedgerByAttention } from './partition-ledger';

const ok = (stdout = 'fine') => ({
  eventType: 'agent.tool_result',
  payload: { content: { exitCode: 0, stdout } },
});
const failed = (stdout = 'boom') => ({
  eventType: 'agent.tool_result',
  payload: { content: { exitCode: 1, stdout } },
});

describe('partitionLedgerByAttention', () => {
  it('surfaces an error that nothing has recovered from', () => {
    const ledger = [{ eventType: 'agent.tool_use', payload: {} }, failed()];

    const { attention } = partitionLedgerByAttention(ledger);

    expect(attention).toHaveLength(1);
    expect(attention[0]!.eventType).toBe('agent.tool_result');
  });

  it('returns an empty attention list when there are no error events', () => {
    const ledger = [{ eventType: 'agent.message', payload: {} }];
    const { attention, activity } = partitionLedgerByAttention(ledger);
    expect(attention).toEqual([]);
    expect(activity).toHaveLength(1);
  });

  it('every event is in exactly one of the two buckets', () => {
    const ledger = [{ eventType: 'agent.tool_use', payload: {} }, failed(), ok()];

    const { attention, activity } = partitionLedgerByAttention(ledger);

    expect(attention.length + activity.length).toBe(ledger.length);
  });

  // The bug this covers: an agent that hits a non-zero exit, self-corrects,
  // and goes on to succeed was flagging every one of those transient failures
  // as a red "Blocker" — on tasks that had already opened a green PR.
  it('does not flag an error the agent recovered from', () => {
    const ledger = [failed('missing dep'), ok('installed'), { eventType: 'agent.message', payload: {} }];

    const { attention } = partitionLedgerByAttention(ledger);

    expect(attention).toEqual([]);
  });

  it('flags only the errors after the last successful tool result', () => {
    const ledger = [
      failed('early, recovered'),
      ok(),
      failed('still broken'),
      { eventType: 'session.error', payload: { error: { message: 'also broken' } } },
    ];

    const { attention } = partitionLedgerByAttention(ledger);

    expect(attention).toHaveLength(2);
    expect(attention.map((e) => e.eventType)).toEqual(['agent.tool_result', 'session.error']);
  });

  it('treats a session.error before a successful tool result as recovered too', () => {
    const ledger = [{ eventType: 'session.error', payload: { error: { message: 'blip' } } }, ok()];

    const { attention } = partitionLedgerByAttention(ledger);

    expect(attention).toEqual([]);
  });

  it('keeps flagging errors when no tool has ever succeeded', () => {
    const ledger = [failed('one'), failed('two')];

    const { attention } = partitionLedgerByAttention(ledger);

    expect(attention).toHaveLength(2);
  });
});
