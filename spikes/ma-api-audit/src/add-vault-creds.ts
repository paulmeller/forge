import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.AGENTSTEP_API_KEY!,
  baseURL: 'https://www.agentstep.com',
});

const VAULT_ID = 'vault_01KQ4S10B9YCDH2Z7PREZSJGYF';

async function tryAddCredential(name: string, body: Record<string, unknown>) {
  console.log(`\n--- trying: ${name} ---`);
  try {
    const result = await (client.beta.vaults.credentials as any).create(VAULT_ID, body);
    console.log('success:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.log('error:', err.status, err.message?.slice(0, 200));
  }
}

// Try 1: Anthropic-standard mcp_oauth format for SPRITE_TOKEN
await tryAddCredential('sprites as mcp_oauth', {
  display_name: 'Sprites Token',
  auth: {
    type: 'mcp_oauth',
    mcp_server_url: 'https://sprites.dev',
    access_token: process.env.SPRITE_TOKEN!,
  },
});

// Try 2: Simple bearer token
await tryAddCredential('openai as bearer', {
  display_name: 'OpenAI Key',
  auth: {
    type: 'bearer',
    token: process.env.OPENAI_API_KEY!,
  },
});

// Try 3: env_var style
await tryAddCredential('sprites as env_var', {
  display_name: 'SPRITE_TOKEN env',
  key: 'SPRITE_TOKEN',
  value: process.env.SPRITE_TOKEN!,
});

// Try 4: Check what the vault looks like
console.log('\n--- vault state ---');
try {
  const vault = await client.beta.vaults.retrieve(VAULT_ID);
  console.log(JSON.stringify(vault, null, 2));
} catch (err: any) {
  console.log('retrieve error:', err.status, err.message?.slice(0, 200));
}
