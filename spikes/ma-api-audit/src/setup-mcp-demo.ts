import Anthropic from '@anthropic-ai/sdk';

const GH_TOKEN = process.env.GH_TOKEN;
if (!GH_TOKEN) throw new Error('set GH_TOKEN');
const MCP_URL = process.env.MCP_URL ?? 'https://api.githubcopilot.com/mcp/';

const client = new Anthropic();
const tag = Date.now().toString(36);

const env = await client.beta.environments.create({
  name: `forge-mcp-env-${tag}`,
  config: { type: 'cloud', networking: { type: 'unrestricted' } },
});

const vault = await client.beta.vaults.create({
  display_name: `forge-mcp-vault-${tag}`,
} as never);
const credential = await client.beta.vaults.credentials.create(vault.id, {
  display_name: 'GitHub MCP (gh CLI token)',
  auth: {
    type: 'mcp_oauth',
    mcp_server_url: MCP_URL,
    access_token: GH_TOKEN,
  },
} as never);

const agent = await client.beta.agents.create({
  name: `forge-mcp-agent-${tag}`,
  model: 'claude-opus-4-7',
  system: `You are Forge's dependency-bump agent.

Protocol:
  1. Read the current package.json in the attached repo.
  2. Bump the target dependency version as requested (edit in place).
  3. Commit on a new branch: forge/<short-slug>.
  4. Push the branch to origin via bash.
  5. Open a pull request against the default branch using the github MCP "create_pull_request" tool.
     Title: concise one-liner. Body: summarise the change + why.
  6. Reply with a short confirmation that includes the PR URL.

Do not modify unrelated files. Keep the final message short.`,
  mcp_servers: [
    { type: 'url', name: 'github', url: MCP_URL },
  ],
  tools: [
    { type: 'agent_toolset_20260401', default_config: { enabled: true } },
    {
      type: 'mcp_toolset',
      mcp_server_name: 'github',
      default_config: {
        enabled: true,
        permission_policy: { type: 'always_allow' },
      },
    },
  ],
} as never);

console.log(
  JSON.stringify({
    environmentId: env.id,
    agentId: agent.id,
    vaultId: vault.id,
    credentialId: credential.id,
  }),
);
