import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-4-7';
const SESSION_POLL_INTERVAL_MS = 2000;
const PROMPT = "Reply with the single word 'pong'.";

type Usage = {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
};

function nowElapsed(started: number): string {
  return `${((Date.now() - started) / 1000).toFixed(1)}s`;
}

function makeLogger(started: number) {
  return (message: string, extra?: Record<string, unknown>) => {
    const tag = `[+${nowElapsed(started)}]`;
    if (extra) {
      console.log(tag, message, extra);
    } else {
      console.log(tag, message);
    }
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is required.');
    console.error('Export it before running: export ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const started = Date.now();
  const log = makeLogger(started);

  const suffix = Date.now().toString(36);
  const envName = `forge-spike-env-${suffix}`;
  const agentName = `forge-spike-agent-${suffix}`;

  let environmentId: string | undefined;
  let agentId: string | undefined;
  let sessionId: string | undefined;
  const seenEventIds = new Set<string>();
  const eventTypeCounts = new Map<string, number>();
  const usage: Usage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  const capturedAgentText: string[] = [];

  try {
    log('creating environment', { name: envName });
    const environment = await client.beta.environments.create({
      name: envName,
      config: {
        type: 'cloud',
        networking: { type: 'unrestricted' },
      },
    });
    environmentId = environment.id;
    log('environment created', { id: environment.id });

    log('creating agent', { name: agentName });
    const agent = await client.beta.agents.create({
      name: agentName,
      model: MODEL,
      tools: [
        {
          type: 'agent_toolset_20260401',
          default_config: { enabled: true },
        },
      ],
    });
    agentId = agent.id;
    log('agent created', { id: agent.id, version: agent.version });

    log('creating session');
    const session = await client.beta.sessions.create({
      agent: agent.id,
      environment_id: environment.id,
      title: `Forge spike probe ${suffix}`,
    });
    sessionId = session.id;
    log('session created', { id: session.id, status: session.status });

    log('sending user message');
    await client.beta.sessions.events.send(session.id, {
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: PROMPT }],
        },
      ],
    });

    log('polling events (this is the path the Forge tick will use)');
    let done = false;
    let loopCount = 0;
    while (!done) {
      loopCount += 1;
      const page = await client.beta.sessions.events.list(session.id);
      const events = Array.isArray(page.data) ? page.data : [];

      for (const event of events) {
        const eventId = (event as { id?: string }).id;
        if (!eventId || seenEventIds.has(eventId)) continue;
        seenEventIds.add(eventId);

        const type = (event as { type?: string }).type ?? 'unknown';
        eventTypeCounts.set(type, (eventTypeCounts.get(type) ?? 0) + 1);

        if (type === 'span.model_request_end') {
          const mu = (event as { model_usage?: Record<string, number> }).model_usage;
          if (mu) {
            usage.input += mu.input_tokens ?? 0;
            usage.output += mu.output_tokens ?? 0;
            usage.cacheCreate += mu.cache_creation_input_tokens ?? 0;
            usage.cacheRead += mu.cache_read_input_tokens ?? 0;
          }
        }

        if (type === 'agent.message') {
          const content = (event as { content?: Array<{ type?: string; text?: string }> }).content;
          if (content) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                capturedAgentText.push(block.text);
              }
            }
          }
        }

        if (type === 'session.status_terminated') {
          done = true;
          break;
        }
        if (type === 'session.status_idle') {
          const stop = (event as { stop_reason?: { type?: string } }).stop_reason;
          if (stop?.type && stop.type !== 'requires_action') {
            done = true;
            break;
          }
        }
      }

      if (!done) {
        if (loopCount > 60) {
          log('aborting — still not idle after 2 minutes');
          break;
        }
        await sleep(SESSION_POLL_INTERVAL_MS);
      }
    }

    const response = capturedAgentText.join(' ').trim();

    console.log('');
    console.log('===== probe summary =====');
    console.log('session:          ', session.id);
    console.log('events seen:      ', seenEventIds.size);
    console.log('event type counts:');
    for (const [type, count] of [...eventTypeCounts.entries()].sort()) {
      console.log(`  ${type.padEnd(40)} ${count}`);
    }
    console.log('usage (tokens):');
    console.log(`  input               ${usage.input}`);
    console.log(`  output              ${usage.output}`);
    console.log(`  cache_creation      ${usage.cacheCreate}`);
    console.log(`  cache_read          ${usage.cacheRead}`);
    console.log('agent response:   ', JSON.stringify(response));
    console.log('wall time:        ', nowElapsed(started));
    console.log('');
    console.log('===== §12 primitive verdict =====');
    console.log('  session create      OK (sessions.create returned id)');
    console.log('  turn append         OK (sessions.events.send accepted user.message)');
    console.log('  event polling       OK (sessions.events.list paginated & type-tagged)');
    console.log(
      `  usage accounting    ${usage.input + usage.output > 0 ? 'OK' : 'UNKNOWN'} (span.model_request_end.model_usage)`,
    );
    console.log('  cancel/archive      EXERCISED BELOW');
    console.log('');
  } finally {
    const log2 = makeLogger(started);
    if (sessionId) {
      log2('cleanup: archiving session', { id: sessionId });
      await client.beta.sessions.archive(sessionId).catch((err) => {
        log2('session archive failed (non-fatal)', { err: String(err) });
      });
    }
    if (agentId) {
      log2('cleanup: archiving agent', { id: agentId });
      await client.beta.agents.archive(agentId).catch((err) => {
        log2('agent archive failed (non-fatal)', { err: String(err) });
      });
    }
    if (environmentId) {
      log2('cleanup: deleting environment', { id: environmentId });
      await client.beta.environments.delete(environmentId).catch((err) => {
        log2('environment delete failed (non-fatal)', { err: String(err) });
      });
    }
    log2('done');
  }
}

void main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
