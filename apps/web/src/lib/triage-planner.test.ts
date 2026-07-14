import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildTriageTaskRows,
  githubSearchIssues,
  mapSearchItems,
  type TriageIssue,
} from './triage-planner';

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

describe('githubSearchIssues', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const searchItem = (n: number) => ({
    number: n,
    title: `bug ${n}`,
    body: 'x',
    html_url: `https://github.com/vercel/ai/issues/${n}`,
    repository_url: 'https://api.github.com/repos/vercel/ai',
  });

  const jsonResponse = (body: unknown, ok = true, status = 200) =>
    ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

  it('throws when GITHUB_APP_TOKEN is not configured', async () => {
    vi.stubEnv('GITHUB_APP_TOKEN', '');
    await expect(githubSearchIssues('repo:vercel/ai is:issue')).rejects.toThrow(
      'GITHUB_APP_TOKEN not configured',
    );
  });

  it('returns mapped issues and the total count from one page', async () => {
    vi.stubEnv('GITHUB_APP_TOKEN', 'tok');
    const fetchMock = vi.fn(async () =>
      jsonResponse({ total_count: 2, items: [searchItem(1), searchItem(2)] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { issues, totalCount } = await githubSearchIssues('repo:vercel/ai is:issue');
    expect(issues).toHaveLength(2);
    expect(totalCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // partial page → no second request
  });

  it('stops after one full page (already past the per-Mission cap) but reports the true total', async () => {
    vi.stubEnv('GITHUB_APP_TOKEN', 'tok');
    const fullPage = Array.from({ length: 100 }, (_, i) => searchItem(i + 1));
    const fetchMock = vi.fn(async () => jsonResponse({ total_count: 999, items: fullPage }));
    vi.stubGlobal('fetch', fetchMock);

    const { issues, totalCount } = await githubSearchIssues('repo:vercel/ai is:issue');
    // One full page fills the cap, so no further pages are fetched...
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(issues).toHaveLength(100);
    // ...but total_count is preserved so the Planner can flag truncation.
    expect(totalCount).toBe(999);
  });

  it('throws a PlannerError on a non-ok response', async () => {
    vi.stubEnv('GITHUB_APP_TOKEN', 'tok');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'bad creds' }, false, 401)));
    await expect(githubSearchIssues('repo:vercel/ai')).rejects.toThrow('github issue search failed (401)');
  });
});
