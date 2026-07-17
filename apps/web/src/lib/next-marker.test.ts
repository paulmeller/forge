import { describe, expect, it } from 'vitest';

import { updateNextIssueRefs } from './next-marker';

describe('updateNextIssueRefs', () => {
  it('adds an issueRef to an empty/null list', () => {
    expect(updateNextIssueRefs(null, 'acme/api#1', true)).toEqual(['acme/api#1']);
    expect(updateNextIssueRefs([], 'acme/api#1', true)).toEqual(['acme/api#1']);
  });

  it('is a no-op when adding an issueRef already present', () => {
    expect(updateNextIssueRefs(['acme/api#1'], 'acme/api#1', true)).toEqual(['acme/api#1']);
  });

  it('removes an issueRef when unmarking', () => {
    expect(updateNextIssueRefs(['acme/api#1', 'acme/api#2'], 'acme/api#1', false)).toEqual([
      'acme/api#2',
    ]);
  });

  it('is a no-op when unmarking an issueRef not present', () => {
    expect(updateNextIssueRefs(['acme/api#2'], 'acme/api#1', false)).toEqual(['acme/api#2']);
  });

  it('preserves other entries when adding alongside existing ones', () => {
    expect(updateNextIssueRefs(['acme/api#2'], 'acme/api#1', true).sort()).toEqual(
      ['acme/api#1', 'acme/api#2'].sort(),
    );
  });
});
