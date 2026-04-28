function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  DATABASE_URL: required('DATABASE_URL', process.env.DATABASE_URL),
  DATABASE_AUTH_TOKEN: process.env.DATABASE_AUTH_TOKEN,
  PORT: Number(process.env.PORT ?? 8080),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',

  // Cloud Run sets this to the service's own URL. Used as the expected
  // audience when verifying Cloud Scheduler's OIDC token.
  TICK_EXPECTED_AUDIENCE: process.env.TICK_EXPECTED_AUDIENCE,
  // Service account email Cloud Scheduler uses to call us. Optional but
  // adds a second line of defense.
  TICK_EXPECTED_ISSUER_EMAIL: process.env.TICK_EXPECTED_ISSUER_EMAIL,
  // When true, skip OIDC verification (for local dev only).
  TICK_ALLOW_UNAUTHENTICATED: process.env.TICK_ALLOW_UNAUTHENTICATED === 'true',

  // Backend adapter config — only required for the backend(s) actually in use.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  FORGE_MA_ENVIRONMENT_ID: process.env.FORGE_MA_ENVIRONMENT_ID,
  GATEWAY_URL: process.env.GATEWAY_URL,
  GATEWAY_API_KEY: process.env.GATEWAY_API_KEY,

  // GitHub App credentials for repo cloning (used inside adapter.createSession)
  // and for Checks API polling (CI status).
  GITHUB_APP_TOKEN: process.env.GITHUB_APP_TOKEN,

  // Retry cap for CI-triggered follow-up turns (PRD §7.5).
  TASK_RETRY_MAX: Number(process.env.TASK_RETRY_MAX ?? 3),
};
