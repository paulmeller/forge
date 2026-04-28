import Anthropic from '@anthropic-ai/sdk';

const sessionId = process.argv[2];
if (!sessionId) {
  console.error('usage: tsx interrupt.ts <sessionId>');
  process.exit(1);
}

const client = new Anthropic();
try {
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: 'user.interrupt' }],
  } as never);
  await new Promise((r) => setTimeout(r, 2000));
} catch (e) {
  console.log('interrupt send:', String(e).slice(0, 200));
}
try {
  await client.beta.sessions.archive(sessionId);
  console.log('archived', sessionId);
} catch (e) {
  console.log('archive:', String(e).slice(0, 200));
}
