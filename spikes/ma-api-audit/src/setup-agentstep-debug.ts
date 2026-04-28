import Anthropic from '@anthropic-ai/sdk';

const AGENTSTEP_URL = process.env.AGENTSTEP_URL ?? 'https://agentstep.com';
const AGENTSTEP_KEY = process.env.AGENTSTEP_API_KEY;
if (!AGENTSTEP_KEY) throw new Error('set AGENTSTEP_API_KEY');

const client = new Anthropic({
  apiKey: AGENTSTEP_KEY,
  baseURL: AGENTSTEP_URL,
});

try {
  console.log('--- creating environment ---');
  const env = await client.beta.environments.create({
    name: `forge-debug-${Date.now()}`,
    config: {
      type: 'cloud',
      networking: { type: 'unrestricted' },
    },
  } as never);
  console.log('env response:', JSON.stringify(env, null, 2));
} catch (err) {
  console.log('env error:', err instanceof Error ? err.message : String(err));
  if (err && typeof err === 'object' && 'status' in err) {
    console.log('status:', (err as { status: number }).status);
  }
}

try {
  console.log('\n--- creating agent ---');
  const agent = await client.beta.agents.create({
    name: `forge-debug-agent-${Date.now()}`,
    model: 'codex/gpt-5.4-mini',
    system: 'You are a test agent.',
    tools: [{ type: 'agent_toolset_20260401' }],
  } as never);
  console.log('agent response:', JSON.stringify(agent, null, 2));
} catch (err) {
  console.log('agent error:', err instanceof Error ? err.message : String(err));
  if (err && typeof err === 'object' && 'status' in err) {
    console.log('status:', (err as { status: number }).status);
  }
}
