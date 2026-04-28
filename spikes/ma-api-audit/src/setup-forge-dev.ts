import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(resolve(__dirname, '../../../skills/forge-dev/SKILL.md'), 'utf-8');

const client = new Anthropic({
  apiKey: process.env.AGENTSTEP_KEY!,
  baseURL: 'https://www.agentstep.com',
});

const agent = await client.beta.agents.create({
  name: 'forge-self-dev',
  model: 'claude-sonnet-4-6',
  system: `You are a senior developer working on the Forge codebase. Execute every task directly — read, edit, test, commit, push. Never just analyze.\n\n${skill}`,
  tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: true } }],
} as never);
console.log('agent:', agent.id);

const vault = await (client.beta.vaults as any).create({
  display_name: 'forge-self-dev',
  agent_id: agent.id,
});
console.log('vault:', vault.id);

console.log(JSON.stringify({ agentId: agent.id, vaultId: vault.id }));
