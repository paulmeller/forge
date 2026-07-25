import { describe, expect, it } from 'vitest';

import { partitionLedgerByAttention } from './partition-ledger';

describe('partitionLedgerByAttention', () => {
  it('splits error events into attention, everything else into activity', () => {
    const ledger = [
      { eventType: 'agent.message', payload: {} },
      { eventType: 'agent.tool_result', payload: { is_error: true } },
      { eventType: 'agent.tool_use', payload: {} },
      { eventType: 'session.error', payload: { error: { message: 'boom' } } },
    ];

    const { attention, activity } = partitionLedgerByAttention(ledger);

    expect(attention).toHaveLength(2);
    expect(attention.map((e) => e.eventType)).toEqual(['agent.tool_result', 'session.error']);
    expect(activity).toHaveLength(2);
    expect(activity.map((e) => e.eventType)).toEqual(['agent.message', 'agent.tool_use']);
  });

  it('returns an empty attention list when there are no error events', () => {
    const ledger = [{ eventType: 'agent.message', payload: {} }];
    const { attention, activity } = partitionLedgerByAttention(ledger);
    expect(attention).toEqual([]);
    expect(activity).toHaveLength(1);
  });
});
