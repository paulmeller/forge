import { describe, expect, it } from 'vitest';

import { deriveMissionName, pickMissionDefaults } from './mission-defaults';

describe('deriveMissionName', () => {
  it('takes the first sentence of the goal', () => {
    expect(
      deriveMissionName('Bump fast-glob to ^3.3.2. Run the tests. Revert on failure.'),
    ).toBe('Bump fast-glob to ^3.3.2');
  });

  it('splits on newlines and question/exclamation marks too', () => {
    expect(deriveMissionName('Fix the login bug\nThen deploy')).toBe('Fix the login bug');
    expect(deriveMissionName('Why is CI red? Investigate.')).toBe('Why is CI red');
  });

  it('truncates to 80 characters', () => {
    const goal = 'a'.repeat(200);
    expect(deriveMissionName(goal)).toHaveLength(80);
  });

  it('skips leading blank lines', () => {
    expect(deriveMissionName('\n\n  Ship it\nrest')).toBe('Ship it');
  });

  it('falls back to Untitled Mission for empty or whitespace goals', () => {
    expect(deriveMissionName('')).toBe('Untitled Mission');
    expect(deriveMissionName('   \n  ')).toBe('Untitled Mission');
  });
});

describe('pickMissionDefaults', () => {
  const install = { installationId: 146708939, agentId: 'agent_setup', githubVaultId: 'vault_setup' };
  const envD = { agentId: 'agent_env', githubVaultId: 'vault_env' };
  const noEnv = { agentId: undefined, githubVaultId: undefined };

  it('prefers installation values and reports source setup', () => {
    expect(pickMissionDefaults(install, envD)).toEqual({
      agentId: 'agent_setup',
      githubInstallationId: '146708939',
      githubVaultId: 'vault_setup',
      source: 'setup',
    });
  });

  it('falls back to env when there is no installation', () => {
    expect(pickMissionDefaults(undefined, envD)).toEqual({
      agentId: 'agent_env',
      githubInstallationId: null,
      githubVaultId: 'vault_env',
      source: 'env',
    });
  });

  it('keeps the installation id but uses env agent when the installation has none', () => {
    const result = pickMissionDefaults({ ...install, agentId: null }, envD);
    expect(result.agentId).toBe('agent_env');
    expect(result.githubInstallationId).toBe('146708939');
    expect(result.source).toBe('env');
  });

  it('reports none when nothing resolves an agent', () => {
    expect(pickMissionDefaults(undefined, noEnv)).toEqual({
      agentId: null,
      githubInstallationId: null,
      githubVaultId: null,
      source: 'none',
    });
  });
});
