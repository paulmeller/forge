import { describe, expect, it } from 'vitest';

import { buildCreateIssuePayload, parseLabelsInput } from './github-issue-create';

describe('parseLabelsInput', () => {
  it('splits comma-separated labels and trims whitespace', () => {
    expect(parseLabelsInput('bug, p1,  needs-repro')).toEqual(['bug', 'p1', 'needs-repro']);
  });

  it('splits newline-separated labels', () => {
    expect(parseLabelsInput('bug\np1\nneeds-repro')).toEqual(['bug', 'p1', 'needs-repro']);
  });

  it('handles mixed commas and newlines', () => {
    expect(parseLabelsInput('bug,\np1, needs-repro')).toEqual(['bug', 'p1', 'needs-repro']);
  });

  it('filters out empty segments from trailing/duplicate separators', () => {
    expect(parseLabelsInput('bug,, p1,')).toEqual(['bug', 'p1']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseLabelsInput('')).toEqual([]);
    expect(parseLabelsInput('   ')).toEqual([]);
  });
});

describe('buildCreateIssuePayload', () => {
  it('trims the title', () => {
    expect(buildCreateIssuePayload({ title: '  Fix the thing  ' })).toEqual({
      title: 'Fix the thing',
    });
  });

  it('omits body when empty or whitespace-only', () => {
    expect(buildCreateIssuePayload({ title: 'x', body: '' })).toEqual({ title: 'x' });
    expect(buildCreateIssuePayload({ title: 'x', body: '   ' })).toEqual({ title: 'x' });
  });

  it('trims and includes body when present', () => {
    expect(buildCreateIssuePayload({ title: 'x', body: '  details  ' })).toEqual({
      title: 'x',
      body: 'details',
    });
  });

  it('omits labels when the array is empty or absent', () => {
    expect(buildCreateIssuePayload({ title: 'x', labels: [] })).toEqual({ title: 'x' });
    expect(buildCreateIssuePayload({ title: 'x' })).toEqual({ title: 'x' });
  });

  it('includes labels when present, dropping empty strings', () => {
    expect(buildCreateIssuePayload({ title: 'x', labels: ['bug', '', 'p1'] })).toEqual({
      title: 'x',
      labels: ['bug', 'p1'],
    });
  });

  it('includes title, body, and labels together', () => {
    expect(
      buildCreateIssuePayload({ title: ' x ', body: ' y ', labels: ['bug'] }),
    ).toEqual({ title: 'x', body: 'y', labels: ['bug'] });
  });
});
