import { describe, expect, it } from 'vitest';

import { parseForgeDirective } from './dispatch-from-github';

describe('parseForgeDirective', () => {
  it('returns null for empty/null/undefined', () => {
    expect(parseForgeDirective(null)).toBeNull();
    expect(parseForgeDirective(undefined)).toBeNull();
    expect(parseForgeDirective('')).toBeNull();
  });

  it('parses @forge directive on a single line', () => {
    expect(parseForgeDirective('@forge bump fast-glob to ^3.3.2')).toBe('bump fast-glob to ^3.3.2');
  });

  it('parses /forge directive', () => {
    expect(parseForgeDirective('/forge add OTel spans to every HTTP handler')).toBe(
      'add OTel spans to every HTTP handler',
    );
  });

  it('finds the directive on any line of a multi-line comment', () => {
    const body = `Hey team — let's also do this:

@forge bump fast-glob to ^3.3.2

cc @others`;
    expect(parseForgeDirective(body)).toBe('bump fast-glob to ^3.3.2');
  });

  it('is case-insensitive on the trigger', () => {
    expect(parseForgeDirective('@FORGE bump it')).toBe('bump it');
    expect(parseForgeDirective('@Forge bump it')).toBe('bump it');
  });

  it('ignores @forge with no payload', () => {
    expect(parseForgeDirective('@forge')).toBeNull();
    expect(parseForgeDirective('@forge   ')).toBeNull();
  });

  it('does not match @forge inside a sentence', () => {
    // Trigger must be at line start (after optional whitespace)
    expect(parseForgeDirective('we should ask @forge to bump it')).toBeNull();
  });

  it('takes the first directive line if multiple', () => {
    expect(parseForgeDirective('@forge first thing\n@forge second thing')).toBe('first thing');
  });

  it('handles leading whitespace before the trigger', () => {
    expect(parseForgeDirective('   @forge indented')).toBe('indented');
  });
});
