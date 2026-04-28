import Anthropic from '@anthropic-ai/sdk';

const AGENTSTEP_URL = process.env.AGENTSTEP_URL ?? 'https://agentstep.com';
const AGENTSTEP_KEY = process.env.AGENTSTEP_API_KEY;
if (!AGENTSTEP_KEY) throw new Error('set AGENTSTEP_API_KEY');

const client = new Anthropic({
  apiKey: AGENTSTEP_KEY,
  baseURL: AGENTSTEP_URL,
});

const tag = Date.now().toString(36);

console.log('creating environment (codex + sprites)...');
const env = await client.beta.environments.create({
  name: `forge-codex-sprites-${tag}`,
  config: {
    type: 'cloud',
    networking: { type: 'unrestricted' },
  },
} as never);
console.log('environment:', env.id);

console.log('creating agent (codex)...');
const agent = await client.beta.agents.create({
  name: `forge-ci-fix-codex-${tag}`,
  model: 'codex/gpt-5.4-mini',
  system: `You are a CI-fix agent. When given a failing CI log, you:
1. Read the relevant source files.
2. Identify the root cause of the failure.
3. Fix it with the minimum change.
4. Commit on the current branch and push.
5. Reply with a one-line summary of what you fixed.

Do not refactor unrelated code. Do not add tests unless the failure is a missing test. Keep changes minimal.`,
  tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: true } }],
} as never);
console.log('agent:', agent.id);

console.log(JSON.stringify({
  environmentId: env.id,
  agentId: agent.id,
  agentVersion: (agent as { version?: number }).version,
  backend: 'agentstep',
  model: 'codex/gpt-5.4-mini',
}));
