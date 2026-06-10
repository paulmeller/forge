import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from './skill-loader';

describe('parseFrontmatter', () => {
  it('parses loopPolicy and strips frontmatter from the body', () => {
    const raw = [
      '---',
      'loopPolicy:',
      '  maxTurns: 12',
      '  selfVerify: true',
      '---',
      '# dependency-bump',
      '',
      'Bump a dependency.',
    ].join('\n');
    const { loopPolicy, body } = parseFrontmatter(raw);
    expect(loopPolicy).toEqual({ maxTurns: 12, selfVerify: true });
    expect(body).toBe('# dependency-bump\n\nBump a dependency.');
  });

  it('round-trips a multi-line block scalar (the case a hand-parser would truncate)', () => {
    const raw = [
      '---',
      'loopPolicy:',
      '  acceptanceCriteria: |',
      '    - Only the named dependency changed.',
      '    - typecheck and tests pass.',
      '    - A PR titled `chore(deps): bump` is open.',
      '---',
      '# skill',
    ].join('\n');
    const { loopPolicy } = parseFrontmatter(raw);
    expect(loopPolicy?.acceptanceCriteria).toBe(
      '- Only the named dependency changed.\n- typecheck and tests pass.\n- A PR titled `chore(deps): bump` is open.\n',
    );
  });

  it('ignores frontmatter that has no loopPolicy key', () => {
    const raw = ['---', 'name: ci-fix', 'allowedTools: [bash, read]', '---', '# Protocol'].join(
      '\n',
    );
    const { loopPolicy, body } = parseFrontmatter(raw);
    expect(loopPolicy).toBeNull();
    expect(body).toBe('# Protocol');
  });

  it('a file with no frontmatter loads unchanged with null policy (back-compat)', () => {
    const raw = '# codemod-rollout\n\nApply a codemod.';
    expect(parseFrontmatter(raw)).toEqual({ loopPolicy: null, body: raw });
  });
});
