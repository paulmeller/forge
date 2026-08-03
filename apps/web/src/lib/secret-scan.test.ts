import { describe, expect, it } from 'vitest';

import {
  addedLines,
  describeSecretFindings,
  scanLine,
  scanPatchesForSecrets,
  type SecretFinding,
} from './secret-scan';

// Structurally valid, never-issued values. Assembled at runtime so this file
// itself never contains a literal that a scanner (ours included) would flag.
const GH_TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
const ANTHROPIC = `sk-ant-${'api03-0000000000000000000000'}`;
const AWS_ID = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----';

describe('scanLine', () => {
  it.each([
    ['github token', `const t = "${GH_TOKEN}"`, 'github-token'],
    ['anthropic key', `ANTHROPIC_API_KEY=${ANTHROPIC}`, 'anthropic-api-key'],
    ['aws access key id', `aws_key = '${AWS_ID}'`, 'aws-access-key-id'],
    ['private key block', PRIVATE_KEY, 'private-key-block'],
  ])('detects a %s', (_label, line, detector) => {
    expect(scanLine(line)).toContain(detector);
  });

  it('detects a secret-sounding assignment to a long literal', () => {
    expect(scanLine('CLIENT_SECRET="8f3a9d2b7c1e4f6a0b5d8e2c"')).toContain(
      'generic-secret-assignment',
    );
  });

  it.each([
    ['env-var reference', 'const key = process.env.ANTHROPIC_API_KEY'],
    ['shell interpolation', 'API_KEY=${ANTHROPIC_API_KEY}'],
    ['angle-bracket placeholder', 'api_key: <your-key-here>'],
    ['masked value', 'password = "xxxxxxxxxxxxxxxx"'],
    ['example value', 'SECRET_KEY=change-me-to-a-random-32-char-string'],
    ['prose about secrets', 'Rotate the access token if it was committed.'],
    ['short value', 'token: "abc123"'],
  ])('does not fire on %s', (_label, line) => {
    expect(scanLine(line)).toEqual([]);
  });

  it('does not confuse an anthropic key for an openai one', () => {
    // sk-ant- must not also satisfy the generic sk- rule, or every Anthropic
    // key is reported twice under the wrong vendor.
    expect(scanLine(`key=${ANTHROPIC}`)).toEqual(['anthropic-api-key']);
  });
});

describe('addedLines', () => {
  it('returns added content without the + marker', () => {
    const patch = ['@@ -1,2 +1,3 @@', ' context', '+added one', '+added two', '-removed'].join(
      '\n',
    );
    expect(addedLines(patch)).toEqual(['added one', 'added two']);
  });

  it('ignores the +++ file header', () => {
    expect(addedLines('+++ b/src/app.ts\n+real line')).toEqual(['real line']);
  });
});

describe('scanPatchesForSecrets', () => {
  it('flags a credential on an added line', () => {
    const findings = scanPatchesForSecrets([
      { filename: 'src/client.ts', patch: `@@\n+const token = "${GH_TOKEN}"` },
    ]);
    expect(findings).toEqual([{ file: 'src/client.ts', detector: 'github-token' }]);
  });

  it('ignores a credential on a REMOVED line so cleanup PRs stay mergeable', () => {
    const findings = scanPatchesForSecrets([
      { filename: 'src/client.ts', patch: `@@\n-const token = "${GH_TOKEN}"\n+const token = env.T` },
    ]);
    expect(findings).toEqual([]);
  });

  it('ignores context lines — only what this diff introduces', () => {
    const findings = scanPatchesForSecrets([
      { filename: 'src/client.ts', patch: `@@\n const token = "${GH_TOKEN}"\n+const x = 1` },
    ]);
    expect(findings).toEqual([]);
  });

  it('deduplicates repeated hits of the same rule in one file', () => {
    const patch = `@@\n+a = "${GH_TOKEN}"\n+b = "${GH_TOKEN}"\n+c = "${GH_TOKEN}"`;
    expect(scanPatchesForSecrets([{ filename: 'src/a.ts', patch }])).toHaveLength(1);
  });

  it('reports the same rule separately per file', () => {
    const patch = `@@\n+t = "${GH_TOKEN}"`;
    const findings = scanPatchesForSecrets([
      { filename: 'src/a.ts', patch },
      { filename: 'src/b.ts', patch },
    ]);
    expect(findings.map((f) => f.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('skips files with no patch (binary or too large) without throwing', () => {
    expect(scanPatchesForSecrets([{ filename: 'logo.png' }])).toEqual([]);
  });

  it('never returns the matched secret in the finding', () => {
    const findings = scanPatchesForSecrets([
      { filename: 'src/client.ts', patch: `@@\n+const token = "${GH_TOKEN}"` },
    ]);
    expect(JSON.stringify(findings)).not.toContain(GH_TOKEN);
  });

  it('returns nothing for an ordinary diff', () => {
    const findings = scanPatchesForSecrets([
      {
        filename: 'src/util.ts',
        patch: '@@\n+export function add(a: number, b: number) {\n+  return a + b;\n+}',
      },
    ]);
    expect(findings).toEqual([]);
  });
});

describe('describeSecretFindings', () => {
  const finding = (n: number): SecretFinding => ({ file: `src/f${n}.ts`, detector: 'github-token' });

  it('names the rule and file, and tells the operator to rotate', () => {
    const msg = describeSecretFindings([{ file: 'src/a.ts', detector: 'anthropic-api-key' }]);
    expect(msg).toContain('anthropic-api-key in src/a.ts');
    expect(msg).toContain('rotate');
  });

  it('caps the list so a pathological diff cannot write an unbounded message', () => {
    const msg = describeSecretFindings(Array.from({ length: 9 }, (_, i) => finding(i)));
    expect(msg).toContain('(+4 more)');
    expect(msg).not.toContain('src/f5.ts');
  });
});
