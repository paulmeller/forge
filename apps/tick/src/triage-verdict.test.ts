import { describe, expect, it } from 'vitest';

import { extractVerdictFromLedger, parseVerdict } from './triage-verdict';

describe('parseVerdict', () => {
  it('parses a well-formed verdict block', () => {
    const text = [
      'I ran the repro across versions.',
      '```forge-verdict',
      '{ "reproduced": true, "summary": "empty content instead of null", "affectedVersions": {"v5.0": true, "v6.0": false}, "evidence": "convert.test.ts fails" }',
      '```',
    ].join('\n');
    expect(parseVerdict(text)).toEqual({
      reproduced: true,
      summary: 'empty content instead of null',
      affectedVersions: { 'v5.0': true, 'v6.0': false },
      evidence: 'convert.test.ts fails',
    });
  });

  it('parses a cannot-reproduce verdict', () => {
    const text = '```forge-verdict\n{"reproduced": false, "summary": "works on all versions"}\n```';
    expect(parseVerdict(text)).toEqual({ reproduced: false, summary: 'works on all versions' });
  });

  it('returns null when there is no verdict block', () => {
    expect(parseVerdict('just some prose about the bug')).toBeNull();
  });

  it('returns null for a block missing the required reproduced boolean', () => {
    expect(parseVerdict('```forge-verdict\n{"summary": "no verdict"}\n```')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseVerdict('```forge-verdict\n{not json}\n```')).toBeNull();
  });

  it('takes the last verdict when the agent emitted several', () => {
    const text = [
      '```forge-verdict\n{"reproduced": false, "summary": "first guess"}\n```',
      '```forge-verdict\n{"reproduced": true, "summary": "final answer"}\n```',
    ].join('\n\n');
    expect(parseVerdict(text)?.summary).toBe('final answer');
  });

  it('drops non-boolean version flags', () => {
    const text =
      '```forge-verdict\n{"reproduced": true, "summary": "x", "affectedVersions": {"v5": true, "v6": "maybe"}}\n```';
    expect(parseVerdict(text)?.affectedVersions).toEqual({ v5: true });
  });
});

describe('extractVerdictFromLedger', () => {
  const agentMessage = (text: string) => ({
    eventType: 'agent.message',
    payload: { content: [{ type: 'text', text }] },
  });

  it('finds the verdict inside agent.message content blocks', () => {
    const rows = [
      { eventType: 'session.status_running', payload: {} },
      agentMessage('working on it...'),
      agentMessage('```forge-verdict\n{"reproduced": true, "summary": "done"}\n```'),
    ];
    expect(extractVerdictFromLedger(rows)).toEqual({ reproduced: true, summary: 'done' });
  });

  it('ignores verdict-shaped text in non-agent events', () => {
    const rows = [
      { eventType: 'agent.tool_use', payload: { content: [{ type: 'text', text: '```forge-verdict\n{"reproduced": true, "summary": "x"}\n```' }] } },
    ];
    expect(extractVerdictFromLedger(rows)).toBeNull();
  });

  it('returns the latest verdict across multiple messages', () => {
    const rows = [
      agentMessage('```forge-verdict\n{"reproduced": false, "summary": "early"}\n```'),
      agentMessage('```forge-verdict\n{"reproduced": true, "summary": "late"}\n```'),
    ];
    expect(extractVerdictFromLedger(rows)?.summary).toBe('late');
  });

  it('returns null when no message carries a verdict', () => {
    expect(extractVerdictFromLedger([agentMessage('no verdict here')])).toBeNull();
  });
});
