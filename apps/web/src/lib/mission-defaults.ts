/**
 * Pure helpers for the New Mission composer. This file must stay free of
 * server-only imports (db, env) — client components type-import from it.
 */

export type MissionDefaults = {
  agentId: string | null;
  githubInstallationId: string | null;
  githubVaultId: string | null;
  /** Where the agent id came from — drives the composer's transparency line. */
  source: 'setup' | 'env' | 'none';
};

export type InstallationDefaults = {
  installationId: number;
  agentId: string | null;
  githubVaultId: string | null;
};

export type EnvDefaults = {
  agentId: string | undefined;
  githubVaultId: string | undefined;
};

/** First sentence of the goal, ≤80 chars, fallback "Untitled Mission". */
export function deriveMissionName(goal: string): string {
  // Newlines always end a "sentence"; `.`/`!`/`?` only do when followed by
  // whitespace or end-of-string, so decimals like "^3.3.2" survive intact.
  const firstSentence = goal
    .split(/\n|[.!?](?=\s|$)/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!firstSentence) return 'Untitled Mission';
  return firstSentence.slice(0, 80).trim() || 'Untitled Mission';
}

/** Setup installation wins, env fills gaps, source describes the agent id. */
export function pickMissionDefaults(
  installation: InstallationDefaults | undefined,
  envDefaults: EnvDefaults,
): MissionDefaults {
  const agentId = installation?.agentId ?? envDefaults.agentId ?? null;
  const githubVaultId = installation?.githubVaultId ?? envDefaults.githubVaultId ?? null;
  const githubInstallationId = installation ? String(installation.installationId) : null;
  const source: MissionDefaults['source'] = installation?.agentId
    ? 'setup'
    : agentId
      ? 'env'
      : 'none';
  return { agentId, githubInstallationId, githubVaultId, source };
}
