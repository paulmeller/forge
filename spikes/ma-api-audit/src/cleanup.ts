import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const agentId = process.argv[2];
const envId = process.argv[3];

if (agentId) {
  try {
    await client.beta.agents.archive(agentId);
    console.log('archived agent', agentId);
  } catch (err) {
    console.log('agent archive failed:', String(err));
  }
}
if (envId) {
  try {
    await client.beta.environments.delete(envId);
    console.log('deleted environment', envId);
  } catch (err) {
    console.log('environment delete failed:', String(err));
  }
}
