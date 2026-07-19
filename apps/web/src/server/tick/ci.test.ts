import { describe, expect, it } from 'vitest';

import { buildRetryPrompt, type FailedCheck } from './ci';

describe('buildRetryPrompt', () => {
  const sha = 'abc123def456';

  it('includes the SHA in the prompt', () => {
    const prompt = buildRetryPrompt(sha, []);
    expect(prompt).toContain(sha);
  });

  it('lists a single failed check with name and conclusion', () => {
    const checks: FailedCheck[] = [
      { name: 'lint', conclusion: 'failure' },
    ];
    const prompt = buildRetryPrompt(sha, checks);
    expect(prompt).toContain('- lint (failure)');
  });

  it('includes output title and summary when present', () => {
    const checks: FailedCheck[] = [
      {
        name: 'test-suite',
        conclusion: 'failure',
        output: { title: 'Tests Failed', summary: '3 of 42 tests failed' },
      },
    ];
    const prompt = buildRetryPrompt(sha, checks);
    expect(prompt).toContain('test-suite (failure): Tests Failed — 3 of 42 tests failed');
  });

  it('includes the details URL when present', () => {
    const checks: FailedCheck[] = [
      {
        name: 'build',
        conclusion: 'timed_out',
        detailsUrl: 'https://github.com/acme/api/actions/runs/123',
      },
    ];
    const prompt = buildRetryPrompt(sha, checks);
    expect(prompt).toContain('[https://github.com/acme/api/actions/runs/123]');
  });

  it('handles multiple failed checks', () => {
    const checks: FailedCheck[] = [
      { name: 'lint', conclusion: 'failure' },
      { name: 'test', conclusion: 'failure' },
      { name: 'deploy', conclusion: 'cancelled' },
    ];
    const prompt = buildRetryPrompt(sha, checks);
    expect(prompt).toContain('- lint (failure)');
    expect(prompt).toContain('- test (failure)');
    expect(prompt).toContain('- deploy (cancelled)');
  });

  it('omits output fields when null', () => {
    const checks: FailedCheck[] = [
      { name: 'build', conclusion: 'failure', output: { title: null, summary: null } },
    ];
    const prompt = buildRetryPrompt(sha, checks);
    // Should just have "build (failure)" without trailing ": "
    expect(prompt).toContain('- build (failure)');
    expect(prompt).not.toContain('- build (failure):');
  });

  it('includes instructions to fix and push', () => {
    const prompt = buildRetryPrompt(sha, [{ name: 'ci', conclusion: 'failure' }]);
    expect(prompt).toContain('fix the issue');
    expect(prompt).toContain('push the fix');
  });
});
