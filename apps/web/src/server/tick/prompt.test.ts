import { describe, expect, it } from 'vitest';

import { renderOwnedVars, renderPrompt } from './prompt';

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

describe('renderOwnedVars', () => {
  it('substitutes a Forge-owned placeholder', () => {
    expect(renderOwnedVars('push to {{forge_branch}}', { forge_branch: 'forge/t1' }, ['forge_branch']))
      .toBe('push to forge/t1');
  });

  it("leaves a target repo's own template text untouched", () => {
    // A customer AGENTS.md may document Handlebars or Jinja. renderPrompt would
    // blank these to empty strings; this must not. `vars` deliberately carries
    // a *defined* value for the unowned key 'user' (dispatcher's real vars
    // object has plenty of non-forge_branch keys, e.g. repo/base_branch) —
    // if the ownedKeys allow-list check were ever bypassed, the code would
    // still treat a merely-undefined value as "leave it alone", masking the
    // bug. A defined value is the only thing that actually exercises the
    // allow-list.
    const content = 'Example: {{user}} and {{item.name}} render at runtime.';
    expect(renderOwnedVars(content, { forge_branch: 'forge/t1', user: 'nobody' }, ['forge_branch']))
      .toBe(content);
  });

  it('leaves an owned key alone when its value is missing rather than deleting it', () => {
    expect(renderOwnedVars('push to {{forge_branch}}', {}, ['forge_branch']))
      .toBe('push to {{forge_branch}}');
  });
});
