import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const agent = await client.beta.agents.create({
  name: `forge-demo-agent-${Date.now().toString(36)}`,
  model: 'claude-opus-4-7',
  system:
    'You are a dependency-update agent. When asked to update a dependency, find it in the repo, update the version, run tests, commit on a new branch, push, and open a PR via the GitHub MCP tool.',
  tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: true } }],
});
console.log(agent.id);
