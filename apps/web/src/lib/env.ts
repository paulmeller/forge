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
  /**
   * True only when an operator actually set BETTER_AUTH_URL. `BETTER_AUTH_URL`
   * itself always returns a value (falling back to localhost) so `next build`
   * and same-origin dev usage don't need it set — but that means callers who
   * are about to hand the URL to a *third party* (e.g. a link posted in a
   * GitHub comment) cannot use `!env.BETTER_AUTH_URL` to detect a forgotten
   * config: the fallback is truthy. Use this instead for that check.
   */
  get BETTER_AUTH_URL_IS_CONFIGURED(): boolean {
    return Boolean(optional('BETTER_AUTH_URL'));
  },
  get FORGE_BACKEND(): 'managed-agents' | 'gateway' {
    return (optional('FORGE_BACKEND') ?? 'managed-agents') as 'managed-agents' | 'gateway';
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
  /**
   * Base URL for the *chat* surface's Anthropic-compatible model provider,
   * separate from ANTHROPIC_BASE_URL.
   *
   * These address two different APIs. ANTHROPIC_BASE_URL points at a Managed
   * Agents engine, which serves `/v1/sessions/*` and — in the self-hosted
   * case — no `/v1/messages` route at all. Chat needs `/v1/messages`. Sharing
   * one variable meant pointing Forge at a self-hosted engine silently broke
   * chat, and pointing chat at a plain model endpoint silently broke dispatch.
   *
   * Falls back to ANTHROPIC_BASE_URL so existing single-endpoint setups (where
   * one host serves both) keep working untouched.
   */
  get FORGE_CHAT_BASE_URL(): string {
    return optional('FORGE_CHAT_BASE_URL') ?? this.ANTHROPIC_BASE_URL;
  },
  /** API key for the chat provider; falls back to ANTHROPIC_API_KEY. */
  get FORGE_CHAT_API_KEY(): string | undefined {
    return optional('FORGE_CHAT_API_KEY') ?? optional('ANTHROPIC_API_KEY');
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
  get GEMINI_API_KEY(): string | undefined {
    return optional('GEMINI_API_KEY');
  },
  get FORGE_GEMINI_MODEL(): string {
    return optional('FORGE_GEMINI_MODEL') ?? 'gemini-pro-latest';
  },
  // Git identity dispatched agents commit as. Without these pre-set, the sandbox has no git
  // identity and the agent's first commit fails, forcing it to discover the error and
  // self-recover mid-turn — on every single task.
  get FORGE_GIT_AUTHOR_NAME(): string {
    return optional('FORGE_GIT_AUTHOR_NAME') ?? 'Forge Agent';
  },
  get FORGE_GIT_AUTHOR_EMAIL(): string {
    return optional('FORGE_GIT_AUTHOR_EMAIL') ?? 'forge-agent@users.noreply.github.com';
  },
  get TASK_RETRY_MAX(): number {
    return Number(optional('TASK_RETRY_MAX') ?? 3);
  },
  get TASK_MAX_TURNS(): number {
    return Number(optional('TASK_MAX_TURNS') ?? 30);
  },
  // How many times Forge nudges an agent that ended its turn without pushing a
  // branch ("continue — commit and push") before escalating to a human. This
  // is the stalled-finish budget, distinct from TASK_MAX_TURNS (the runaway
  // ceiling). Small on purpose: the common cause is "forgot to push", which
  // one or two nudges fixes; a task that needs more prodding than this wants a
  // human, not more grinding.
  get TASK_CONTINUATION_MAX(): number {
    return Number(optional('TASK_CONTINUATION_MAX') ?? 3);
  },
  get TASK_NO_PROGRESS_TOKENS(): number {
    // Denominated in FLATTENED tokens (costTokens sums every tier — cache
    // reads included, and they dominate: measured live, raw input is ~2 tokens
    // per call while cache reads run 30-80k). 200k flattened was therefore
    // ~20k real tokens — a handful of tool calls — and halted an agent 29
    // calls into legitimately reading a feature's surface before its first
    // push (no push yet = no #57 reprieve possible). 2M flattened restores the
    // ~200k-real intent the original figure was chosen for. The proper fix is
    // denominating this budget in output tokens; tracked in the issue.
    return Number(optional('TASK_NO_PROGRESS_TOKENS') ?? 2_000_000);
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
  // How long to let an agent work on a CI failure before deciding it is not
  // coming back. A CI retry is only re-sent when the PR head SHA changes (the
  // agent pushed a fix); this bounds the opposite case, where it never pushes
  // and the Task would otherwise sit in awaiting_ci forever. 10 min is enough
  // to read a log, fix, and push, without holding a dead Task all day.
  get RETRY_STALL_MS(): number {
    return Number(optional('RETRY_STALL_MS') ?? 600_000);
  },
  get GATE_STALL_MS(): number {
    return Number(optional('GATE_STALL_MS') ?? 1_800_000); // 30 min gate stall sweep
  },
  get MERGE_STALL_MS(): number {
    return Number(optional('MERGE_STALL_MS') ?? 1_800_000); // 30 min merge stall sweep
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
  /**
   * #67: when true, a dispatch-time contract violation found in the backend
   * agent's own instructions (server/tick/agent-contract.ts) refuses to
   * dispatch the Task instead of only recording a `dispatch.contract_warning`
   * ledger event. Off by default — the checker is a denylist heuristic, not a
   * proof, and a false positive here would halt every Task on the affected
   * agent; a warning nobody reads is a much smaller failure than a
   * fleet-wide false halt.
   */
  get AGENT_CONTRACT_BLOCK(): boolean {
    return optional('AGENT_CONTRACT_BLOCK') === 'true';
  },
  /**
   * Comma-separated allow-list of `client_id`s the device-authorization flow
   * accepts (lib/device-auth.ts). Unset means exactly the first-party CLI —
   * this exists so an operator can add a second trusted client without a code
   * change, not so the list can be widened casually.
   */
  get FORGE_DEVICE_CLIENT_IDS(): string | undefined {
    return optional('FORGE_DEVICE_CLIENT_IDS');
  },
  get FORGE_SKILLS_DIR(): string {
    // Monorepo dev/test default: cwd is apps/web → repo-root skills/.
    // The production image sets this explicitly (Task 7).
    return optional('FORGE_SKILLS_DIR') ?? resolve(process.cwd(), '../../skills');
  },
};
