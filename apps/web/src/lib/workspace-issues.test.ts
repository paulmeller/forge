import { describe, expect, it } from 'vitest';

import type { TriageIssue } from './triage-planner';
import type { IssueGroup } from './triage-view';
import { mergeIssuesWithGroups } from './workspace-issues';

const issue = (over: Partial<TriageIssue> = {}): TriageIssue => ({
  repo: 'acme/api',
  number: 1,
  title: 'Untouched issue',
  body: '',
  url: 'https://github.com/acme/api/issues/1',
  ...over,
});

const group = (over: Partial<IssueGroup> = {}): IssueGroup => ({
  issueRef: 'acme/api#1',
  repo: 'acme/api',
  issueNumber: 1,
  title: 'Untouched issue',
  url: 'https://github.com/acme/api/issues/1',
  reproduce: null,
  fix: null,
  headline: 'reproducing',
  ...over,
});

describe('mergeIssuesWithGroups', () => {
  it('pairs an issue with its group by issueRef', () => {
    const rows = mergeIssuesWithGroups([issue()], [group()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.group).not.toBeNull();
    expect(rows[0]!.group!.issueRef).toBe('acme/api#1');
  });

  it('leaves group null for an issue Forge has not touched', () => {
    const rows = mergeIssuesWithGroups([issue({ number: 2 })], []);
    expect(rows[0]!.group).toBeNull();
  });

  it('preserves the input issue order', () => {
    const rows = mergeIssuesWithGroups(
      [issue({ number: 5 }), issue({ number: 3 }), issue({ number: 9 })],
      [],
    );
    expect(rows.map((r) => r.issue.number)).toEqual([5, 3, 9]);
  });

  it('ignores groups with no matching issue', () => {
    const rows = mergeIssuesWithGroups([issue({ number: 1 })], [
      group({ issueRef: 'acme/api#1' }),
      group({ issueRef: 'acme/api#999' }),
    ]);
    expect(rows).toHaveLength(1);
  });
});
