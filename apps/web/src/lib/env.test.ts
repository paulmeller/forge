import { describe, expect, it } from 'vitest';

import { env } from '@/lib/env';

describe('tick env getters', () => {
  it('coerces numeric vars with tick defaults', () => {
    expect(env.TASK_RETRY_MAX).toBe(3);
    expect(env.TASK_MAX_TURNS).toBe(30);
    expect(env.TASK_NO_PROGRESS_TOKENS).toBe(200_000);
    expect(env.TASK_MAX_TOKENS).toBe(0);
    expect(env.BUDGET_HARD_STOP_PCT).toBe(100);
    expect(env.VERIFY_RETRY_MAX).toBe(2);
    expect(env.GATE_STALL_MS).toBe(1_800_000);
  });

  it('reads numeric overrides from process.env at access time', () => {
    process.env.TASK_RETRY_MAX = '7';
    expect(env.TASK_RETRY_MAX).toBe(7);
    delete process.env.TASK_RETRY_MAX;
  });

  it('coerces TICK_ALLOW_UNAUTHENTICATED as strict boolean', () => {
    expect(env.TICK_ALLOW_UNAUTHENTICATED).toBe(false);
    process.env.TICK_ALLOW_UNAUTHENTICATED = 'true';
    expect(env.TICK_ALLOW_UNAUTHENTICATED).toBe(true);
    delete process.env.TICK_ALLOW_UNAUTHENTICATED;
  });

  it('defaults ANTHROPIC_BASE_URL and VERIFY_MODEL', () => {
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(env.VERIFY_MODEL).toBe('claude-haiku-4-5');
  });

  it('defaults the git identity dispatched agents commit as', () => {
    expect(env.FORGE_GIT_AUTHOR_NAME).toBe('Forge Agent');
    expect(env.FORGE_GIT_AUTHOR_EMAIL).toBe('forge-agent@users.noreply.github.com');
  });

  it('reads git identity overrides from process.env at access time', () => {
    process.env.FORGE_GIT_AUTHOR_NAME = 'Custom Bot';
    process.env.FORGE_GIT_AUTHOR_EMAIL = 'custom-bot@example.com';
    expect(env.FORGE_GIT_AUTHOR_NAME).toBe('Custom Bot');
    expect(env.FORGE_GIT_AUTHOR_EMAIL).toBe('custom-bot@example.com');
    delete process.env.FORGE_GIT_AUTHOR_NAME;
    delete process.env.FORGE_GIT_AUTHOR_EMAIL;
  });
});
