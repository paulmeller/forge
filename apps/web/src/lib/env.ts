import { resolve } from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

// Lazy accessors so module load doesn't throw during `next build` when env
// vars aren't present. Validation fires the first time the value is read.
export const env = {
  get DATABASE_URL(): string {
    return required('DATABASE_URL');
  },
  get DATABASE_AUTH_TOKEN(): string | undefined {
    return optional('DATABASE_AUTH_TOKEN');
  },
  get BETTER_AUTH_SECRET(): string {
    return required('BETTER_AUTH_SECRET');
  },
  get BETTER_AUTH_URL(): string {
    return optional('BETTER_AUTH_URL') ?? 'http://localhost:3000';
  },
  get FORGE_BACKEND(): 'managed-agents' | 'gateway' {
    return (optional('FORGE_BACKEND') ?? 'managed-agents') as 'managed-agents' | 'gateway';
  },
  get TICK_INTERNAL_URL(): string {
    return optional('TICK_INTERNAL_URL') ?? 'http://localhost:8180';
  },
  get ANTHROPIC_API_KEY(): string | undefined {
    return optional('ANTHROPIC_API_KEY');
  },
  get GATEWAY_URL(): string | undefined {
    return optional('GATEWAY_URL');
  },
  // GitHub-reaction dispatch (PRD §16.6 Phase C). Set GITHUB_WEBHOOK_SECRET
  // to enable; FORGE_DEFAULT_AGENT_ID is the agent missions spawned from
  // GitHub use (operator must create one and pin its ID).
  get GITHUB_WEBHOOK_SECRET(): string | undefined {
    return optional('GITHUB_WEBHOOK_SECRET');
  },
  get FORGE_DEFAULT_AGENT_ID(): string | undefined {
    return optional('FORGE_DEFAULT_AGENT_ID');
  },
  get FORGE_DEFAULT_GITHUB_VAULT_ID(): string | undefined {
    return optional('FORGE_DEFAULT_GITHUB_VAULT_ID');
  },
  // GitHub OAuth App (social login)
  get GITHUB_CLIENT_ID(): string | undefined {
    return optional('GITHUB_CLIENT_ID');
  },
  get GITHUB_CLIENT_SECRET(): string | undefined {
    return optional('GITHUB_CLIENT_SECRET');
  },
  // GitHub App (repo access / installations)
  get GITHUB_APP_ID(): string | undefined {
    return optional('GITHUB_APP_ID');
  },
  get GITHUB_APP_PRIVATE_KEY(): string | undefined {
    return optional('GITHUB_APP_PRIVATE_KEY');
  },
  get GITHUB_APP_SLUG(): string {
    return optional('GITHUB_APP_SLUG') ?? 'forge-dev';
  },
  // Token used by the triage Planner to search GitHub issues (same PAT/app
  // token forge-tick uses for its Octokit calls). Read-only search scope is
  // sufficient.
  get GITHUB_APP_TOKEN(): string | undefined {
    return optional('GITHUB_APP_TOKEN');
  },
  // ── merged from apps/tick/src/env.ts (consolidation spec §A) ──
  get ANTHROPIC_BASE_URL(): string {
    return optional('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com';
  },
  get GATEWAY_API_KEY(): string | undefined {
    return optional('GATEWAY_API_KEY');
  },
  get GATEWAY_ENVIRONMENT_ID(): string | undefined {
    return optional('GATEWAY_ENVIRONMENT_ID');
  },
  get FORGE_MA_ENVIRONMENT_ID(): string | undefined {
    return optional('FORGE_MA_ENVIRONMENT_ID');
  },
  get FORGE_MA_DEFAULT_VAULT_ID(): string | undefined {
    return optional('FORGE_MA_DEFAULT_VAULT_ID');
  },
  get TASK_RETRY_MAX(): number {
    return Number(optional('TASK_RETRY_MAX') ?? 3);
  },
  get TASK_MAX_TURNS(): number {
    return Number(optional('TASK_MAX_TURNS') ?? 30);
  },
  get TASK_NO_PROGRESS_TOKENS(): number {
    return Number(optional('TASK_NO_PROGRESS_TOKENS') ?? 200_000);
  },
  get TASK_MAX_TOKENS(): number {
    return Number(optional('TASK_MAX_TOKENS') ?? 0); // 0 = unbounded
  },
  get BUDGET_HARD_STOP_PCT(): number {
    return Number(optional('BUDGET_HARD_STOP_PCT') ?? 100);
  },
  get VERIFY_RETRY_MAX(): number {
    return Number(optional('VERIFY_RETRY_MAX') ?? 2);
  },
  get VERIFY_MODEL(): string {
    return optional('VERIFY_MODEL') ?? 'claude-haiku-4-5'; // checker ≠ maker
  },
  get GATE_STALL_MS(): number {
    return Number(optional('GATE_STALL_MS') ?? 1_800_000); // 30 min gate stall sweep
  },
  get LOG_LEVEL(): string {
    return optional('LOG_LEVEL') ?? 'info';
  },
  get TICK_EXPECTED_AUDIENCE(): string | undefined {
    return optional('TICK_EXPECTED_AUDIENCE');
  },
  get TICK_EXPECTED_ISSUER_EMAIL(): string | undefined {
    return optional('TICK_EXPECTED_ISSUER_EMAIL');
  },
  get TICK_ALLOW_UNAUTHENTICATED(): boolean {
    return optional('TICK_ALLOW_UNAUTHENTICATED') === 'true';
  },
  get FORGE_SKILLS_DIR(): string {
    // Monorepo dev/test default: cwd is apps/web → repo-root skills/.
    // The production image sets this explicitly (Task 7).
    return optional('FORGE_SKILLS_DIR') ?? resolve(process.cwd(), '../../skills');
  },
};
