import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const env = await client.beta.environments.create({
  name: `forge-demo-${Date.now().toString(36)}`,
  config: { type: 'cloud', networking: { type: 'unrestricted' } },
});
console.log(env.id);
