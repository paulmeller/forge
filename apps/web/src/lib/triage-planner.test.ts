import { describe, expect, it } from 'vitest';

import { buildTriageTaskRows, mapSearchItems, type TriageIssue } from './triage-planner';

const issue = (over: Partial<TriageIssue> = {}): TriageIssue => ({
  repo: 'vercel/ai',
  number: 12389,
  title: 'convertToOpenAIChatMessages sends content: "" instead of null',
  body: 'Tool-call-only assistant messages...',
  url: 'https://github.com/vercel/ai/issues/12389',
  ...over,
});

describe('buildTriageTaskRows', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('emits a reproduce→fix pair per issue', () => {
    const rows = buildTriageTaskRows('mis_1', [issue()], now);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind)).toEqual(['reproduce', 'fix']);
  });

  it('gates the fix Task on its own reproduce Task', () => {
    const rows = buildTriageTaskRows('mis_1', [issue()], now);
    const [reproduce, fix] = rows;
    expect(reproduce!.kind).toBe('reproduce');
    expect(reproduce!.dependsOnIds).toBeUndefined();
    expect(fix!.kind).toBe('fix');
    expect(fix!.dependsOnIds).toEqual([reproduce!.id]);
  });

  it('scopes both Tasks to the issue via repo + issueRef', () => {
    const [reproduce, fix] = buildTriageTaskRows('mis_1', [issue()], now);
    expect(reproduce!.repo).toBe('vercel/ai');
    expect(reproduce!.issueRef).toBe('vercel/ai#12389');
    expect(fix!.issueRef).toBe('vercel/ai#12389');
  });

  it('carries issue context into promptVars for template rendering', () => {
    const [reproduce] = buildTriageTaskRows('mis_1', [issue()], now);
    expect(reproduce!.promptVars).toMatchObject({
      repo: 'vercel/ai',
      issue_number: 12389,
      issue_title: expect.stringContaining('convertToOpenAIChatMessages'),
      issue_url: 'https://github.com/vercel/ai/issues/12389',
    });
  });

  it('keeps each issue’s pair independent across a multi-repo backlog', () => {
    const rows = buildTriageTaskRows('mis_1', [
      issue({ repo: 'vercel/ai', number: 1 }),
      issue({ repo: 'acme/api', number: 2 }),
    ], now);
    expect(rows).toHaveLength(4);
    const fixes = rows.filter((r) => r.kind === 'fix');
    // Each fix depends only on the reproduce from its own issue.
    for (const fix of fixes) {
      expect(fix.dependsOnIds).toHaveLength(1);
      const dep = rows.find((r) => r.id === fix.dependsOnIds![0]);
      expect(dep!.issueRef).toBe(fix.issueRef);
    }
  });

  it('emits nothing for zero issues', () => {
    expect(buildTriageTaskRows('mis_1', [], now)).toEqual([]);
  });
});

describe('mapSearchItems', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    number: 12389,
    title: 'a bug',
    body: 'details',
    html_url: 'https://github.com/vercel/ai/issues/12389',
    repository_url: 'https://api.github.com/repos/vercel/ai',
    ...over,
  });

  it('parses owner/repo from the repository_url', () => {
    const [mapped] = mapSearchItems([item()]);
    expect(mapped!.repo).toBe('vercel/ai');
    expect(mapped!.number).toBe(12389);
  });

  it('drops pull requests (search returns PRs as issues)', () => {
    const mapped = mapSearchItems([item(), item({ pull_request: { url: 'x' } })]);
    expect(mapped).toHaveLength(1);
  });

  it('coerces a null body to empty string', () => {
    const [mapped] = mapSearchItems([item({ body: null })]);
    expect(mapped!.body).toBe('');
  });

  it('drops items whose repo cannot be parsed', () => {
    const mapped = mapSearchItems([item({ repository_url: 'garbage' })]);
    expect(mapped).toHaveLength(0);
  });
});
