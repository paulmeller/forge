import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const tag = Date.now().toString(36);

const env = await client.beta.environments.create({
  name: `forge-demo-${tag}`,
  config: { type: 'cloud', networking: { type: 'unrestricted' } },
});

const agent = await client.beta.agents.create({
  name: `forge-demo-agent-${tag}`,
  model: 'claude-opus-4-7',
  system: `You are Forge's dependency-bump agent.

When given a task, follow this exact protocol:

1. Read the current package.json.
2. Bump the target dependency to the requested version (edit package.json in place).
3. Commit the change on a new branch named forge/<task-id-or-short-slug>.
4. Push the branch to origin.
5. Reply with a single line: "BRANCH: <full branch name> READY".

Do NOT open a PR — a human will handle that. Do not modify unrelated files. If tests exist, run them and surface the result. Keep your final message short.`,
  tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: true } }],
});

console.log(JSON.stringify({ environmentId: env.id, agentId: agent.id, agentVersion: agent.version }));
