import { describe, expect, it } from 'vitest';

import { evaluatePolicy, _globMatch } from './auto-merge';

describe('evaluatePolicy', () => {
  const noFiles = { files: null };

  it('passes a small diff inside all caps', () => {
    expect(
      evaluatePolicy(
        { additions: 5, deletions: 3, filesChanged: 1, ...noFiles },
        { enabled: true, maxAdditions: 20, maxDeletions: 20, maxFilesChanged: 5 },
      ),
    ).toEqual([]);
  });

  it('blocks when additions exceed cap', () => {
    const reasons = evaluatePolicy(
      { additions: 50, deletions: 0, filesChanged: 1, ...noFiles },
      { enabled: true, maxAdditions: 20 },
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/additions 50.*maxAdditions 20/);
  });

  it('blocks when deletions exceed cap', () => {
    const reasons = evaluatePolicy(
      { additions: 0, deletions: 100, filesChanged: 1, ...noFiles },
      { enabled: true, maxDeletions: 50 },
    );
    expect(reasons[0]).toMatch(/deletions 100.*maxDeletions 50/);
  });

  it('blocks when filesChanged exceeds cap', () => {
    const reasons = evaluatePolicy(
      { additions: 1, deletions: 1, filesChanged: 12, ...noFiles },
      { enabled: true, maxFilesChanged: 3 },
    );
    expect(reasons[0]).toMatch(/filesChanged 12.*maxFilesChanged 3/);
  });

  it('aggregates multiple violations', () => {
    const reasons = evaluatePolicy(
      { additions: 100, deletions: 100, filesChanged: 100, ...noFiles },
      { enabled: true, maxAdditions: 10, maxDeletions: 10, maxFilesChanged: 1 },
    );
    expect(reasons).toHaveLength(3);
  });

  it('treats undefined caps as no constraint', () => {
    expect(
      evaluatePolicy({ additions: 999, deletions: 999, filesChanged: 99, ...noFiles }, { enabled: true }),
    ).toEqual([]);
  });
});

describe('globMatch', () => {
  it('matches exact paths', () => {
    expect(_globMatch('package.json', 'package.json')).toBe(true);
    expect(_globMatch('src/foo.ts', 'package.json')).toBe(false);
  });

  it('* does not cross directory boundaries', () => {
    expect(_globMatch('foo.ts', '*.ts')).toBe(true);
    expect(_globMatch('src/foo.ts', '*.ts')).toBe(false);
  });

  it('** crosses directory boundaries', () => {
    expect(_globMatch('src/foo.ts', '**/*.ts')).toBe(true);
    expect(_globMatch('src/nested/deep/foo.ts', '**/*.ts')).toBe(true);
  });

  it('escapes regex meta characters', () => {
    expect(_globMatch('package.json', 'package.json')).toBe(true);
    expect(_globMatch('packageXjson', 'package.json')).toBe(false);
  });

  it('matches lockfile-only policy', () => {
    const allowlist = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
    expect(allowlist.some((p) => _globMatch('package-lock.json', p))).toBe(true);
    expect(allowlist.some((p) => _globMatch('src/foo.ts', p))).toBe(false);
  });
});
