import Anthropic from '@anthropic-ai/sdk';

const issueNum = Number(process.argv[2]);
if (!issueNum) { console.error('usage: tsx dispatch-issue.ts <issue-number>'); process.exit(1); }

const client = new Anthropic({
  apiKey: process.env.AGENTSTEP_KEY!,
  baseURL: 'https://www.agentstep.com',
});

// Fetch issue from GitHub
const gh = await fetch(`https://api.github.com/repos/paulmeller/forge/issues/${issueNum}`, {
  headers: { Authorization: `token ${process.env.GH_TOKEN}` },
});
const issue = await gh.json() as { title: string; body: string };
console.log(`Issue #${issueNum}: ${issue.title}`);

const session = await client.beta.sessions.create({
  agent: process.env.AGENT_ID!,
  environment_id: process.env.ENV_ID!,
  vault_ids: [process.env.VAULT_ID!],
  resources: [{
    type: 'github_repository',
    url: 'https://github.com/paulmeller/forge',
    authorization_token: process.env.GH_TOKEN!,
    checkout: { type: 'branch', name: 'main' },
  }],
} as never);
console.log(`Session: ${session.id}`);

await client.beta.sessions.events.send(session.id, {
  events: [{
    type: 'user.message',
    content: [{ type: 'text', text: `Read AGENTS.md at /mnt/session/resources/repo_0/AGENTS.md first.

GitHub Issue #${issueNum}: ${issue.title}

${issue.body}

Create branch feat/issue-${issueNum} from main. Implement everything in the spec. Run pnpm -r typecheck to verify. Commit and push.` }],
  }],
} as never);
console.log('Message sent. Polling...');

let done = false;
for (let i = 0; i < 40 && !done; i++) {
  await new Promise(r => setTimeout(r, 15000));
  const events = await client.beta.sessions.events.list(session.id);
  const evts = (events as any).data ?? [];
  const tools = evts.filter((e: any) => e.type === 'agent.tool_use').length;
  const status = evts.find((e: any) =>
    (e.type === 'session.status_idle' || e.type === 'session.status_terminated') &&
    e.stop_reason?.type && e.stop_reason.type !== 'requires_action'
  );
  const msgs = evts.filter((e: any) => e.type === 'agent.message');
  const lastMsg = msgs.at(-1)?.content?.find((b: any) => b.type === 'text')?.text?.slice(0, 80) ?? '';
  console.log(`  [${i+1}] ${evts.length} evts, ${tools} tools ${lastMsg ? `"${lastMsg}"` : ''}`);
  if (status) {
    console.log(`  → ${status.type} stop=${status.stop_reason?.type}`);
    done = true;
  }
}
console.log('Done.');
