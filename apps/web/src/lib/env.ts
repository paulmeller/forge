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
};
