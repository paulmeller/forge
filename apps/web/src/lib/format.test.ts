import { describe, expect, it } from 'vitest';

import { formatConsoleTime, formatDateTime, formatRelative, formatTokens, formatUsd } from './format';

describe('formatDateTime', () => {
  // NB: these tests are timezone-safe; no-Z ISO inputs parse in local time and format in local time, cancelling out.
  const date = new Date('2026-07-17T09:43:00');

  it('formats without seconds by default', () => {
    expect(formatDateTime(date)).toBe('Jul 17, 9:43 AM');
  });

  it('formats with seconds when requested', () => {
    expect(formatDateTime(date, { seconds: true })).toBe('Jul 17, 9:43:00 AM');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-07-17T12:00:00').getTime();

  it('formats seconds', () => {
    expect(formatRelative(new Date(now - 42_000), now)).toBe('42s ago');
  });

  it('formats minutes', () => {
    expect(formatRelative(new Date(now - 5 * 60_000), now)).toBe('5m ago');
  });

  it('formats hours', () => {
    expect(formatRelative(new Date(now - 3 * 3_600_000), now)).toBe('3h ago');
  });

  it('formats days', () => {
    expect(formatRelative(new Date(now - 2 * 86_400_000), now)).toBe('2d ago');
  });

  it('defaults nowMs to Date.now()', () => {
    const justNow = new Date(Date.now() - 1000);
    expect(formatRelative(justNow)).toMatch(/^[12]s ago$/);
  });
});

describe('formatUsd', () => {
  it('formats zero', () => {
    expect(formatUsd(0)).toBe('$0');
  });

  it('formats sub-dollar amounts with cents', () => {
    expect(formatUsd(0.19)).toBe('$0.19');
  });

  it('formats whole dollars with no decimals', () => {
    expect(formatUsd(12)).toBe('$12');
  });

  // NB: this pins today's actual rendered behavior of the canonical source
  // (progress-pill.tsx's formatUsd), which rounds to whole dollars once the
  // amount is >= $1 — including non-integer inputs. Some local formatters
  // elsewhere in the codebase (e.g. repo-budget-line.tsx, budget-gauge.tsx)
  // show cents in this range instead; those have different semantics and
  // were deliberately left unmigrated (see task-3-report.md).
  it('rounds fractional amounts >= $1 to whole dollars', () => {
    expect(formatUsd(12.34)).toBe('$12');
  });
});

describe('formatTokens', () => {
  it('formats sub-1000 counts as-is', () => {
    expect(formatTokens(512)).toBe('512');
  });

  it('formats thousands with one decimal and a k suffix', () => {
    expect(formatTokens(36_600)).toBe('36.6k');
  });

  it('formats millions with two decimals and an M suffix', () => {
    expect(formatTokens(1_318_999)).toBe('1.32M');
  });
});

describe('formatConsoleTime', () => {
  it('formats as deterministic UTC HH:MM:SSZ regardless of local timezone', () => {
    expect(formatConsoleTime(new Date('2026-07-17T21:07:19.000Z'))).toBe('21:07:19Z');
  });

  it('zero-pads single-digit components', () => {
    expect(formatConsoleTime(new Date('2026-01-01T03:04:05.000Z'))).toBe('03:04:05Z');
  });

  it('falls back to a placeholder instead of throwing for an invalid date', () => {
    expect(formatConsoleTime(new Date('not a date'))).toBe('--:--:--Z');
  });
});
