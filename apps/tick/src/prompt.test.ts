import { describe, expect, it } from 'vitest';

import { renderPrompt } from './prompt';

describe('renderPrompt', () => {
  it('substitutes {{var}} placeholders', () => {
    expect(renderPrompt('Bump in {{repo}}', { repo: 'acme/api' })).toBe('Bump in acme/api');
  });

  it('handles whitespace inside braces', () => {
    expect(renderPrompt('{{ repo }} on {{  base_branch  }}', { repo: 'a/b', base_branch: 'main' })).toBe(
      'a/b on main',
    );
  });

  it('substitutes the same var multiple times', () => {
    expect(renderPrompt('{{repo}} → {{repo}}', { repo: 'a/b' })).toBe('a/b → a/b');
  });

  it('replaces missing variables with empty string', () => {
    expect(renderPrompt('Hello {{name}}!', {})).toBe('Hello !');
  });

  it('coerces non-string values', () => {
    expect(renderPrompt('count={{n}}', { n: 42 })).toBe('count=42');
    expect(renderPrompt('flag={{f}}', { f: true })).toBe('flag=true');
  });

  it('null and undefined become empty', () => {
    expect(renderPrompt('a={{a}} b={{b}}', { a: null, b: undefined })).toBe('a= b=');
  });

  it('does not match malformed placeholders', () => {
    expect(renderPrompt('{repo} is single brace', { repo: 'X' })).toBe('{repo} is single brace');
    expect(renderPrompt('{{}} empty', {})).toBe('{{}} empty');
  });
});
