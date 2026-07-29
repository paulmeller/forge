# Operator Setup Guide

This guide gets a new operator from a fresh clone to the first local Mission. For product context, read the [README](../README.md) and [Forge PRD](./forge-prd.md) instead of duplicating them here.

## 1. Prerequisites

- Node.js 22; the repo pins the expected version in `.nvmrc`.
- pnpm 10; the root `package.json` declares the exact package manager line.
- Git and a GitHub account with access to the target repositories.
- One execution backend:
  - Anthropic Managed Agents API key, or
  - AgentStep Gateway API key and API URL.

## 2. Clone and Install

```bash
git clone https://github.com/paulmeller/forge.git
cd forge
pnpm install
```

## 3. Create Local Env Files

Copy the checked-in examples, then edit the copies only:

```bash
cp apps/web/.env.example apps/web/.env.local
```

For local web, set `BETTER_AUTH_URL` to the dev port used by `@forge/web`:

```bash
BETTER_AUTH_URL=http://localhost:3100
```

Use one backend path.

### Anthropic Managed Agents

In `apps/web/.env.local`:

```bash
FORGE_BACKEND=managed-agents
ANTHROPIC_API_KEY=sk-ant-...
FORGE_MA_ENVIRONMENT_ID=env_...
```

Create the Managed Agents agent and environment out of band, then keep the agent ID for the Mission form.

### AgentStep Gateway

In `apps/web/.env.local`:

```bash
FORGE_BACKEND=gateway
GATEWAY_URL=https://www.agentstep.com
GATEWAY_API_KEY=agst_...
```

Create the AgentStep environment, agent, and vault with the API. Use the canonical `www.agentstep.com` host so POST bodies are not lost to redirects.

```bash
export GATEWAY_URL=https://www.agentstep.com
export GATEWAY_API_KEY=agst_...

curl -sS -X POST "$GATEWAY_URL/v1/environments" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "forge-local",
    "config": {
      "type": "cloud",
      "provider": "sprites",
      "networking": { "type": "unrestricted" }
    }
  }'

curl -sS -X POST "$GATEWAY_URL/v1/agents" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "forge-codex",
    "engine": "codex",
    "model": "gpt-5.4"
  }'

curl -sS -X POST "$GATEWAY_URL/v1/vaults" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "forge-github",
    "agent_id": "agent_..."
  }'
```

Save the returned `agent_...`, environment ID, and `vault_...`. Paste the agent ID and vault ID into the Mission form when requested.

## 4. Run Migrations

Generate and apply the local database migration:

```bash
pnpm --filter @forge/db db:generate
pnpm --filter @forge/db db:migrate
```

## 5. Start Forge

Run the app from the repo root:

```bash
pnpm dev
```

- Console: `http://localhost:3100`

## 6. Sign Up

Open `http://localhost:3100/signup` and create the first local operator account.

## 7. Create the First Mission

In the Console, go to `http://localhost:3100/missions/new` and fill in:

- Name and goal prompt.
- Backend: Anthropic Managed Agents or AgentStep Gateway.
- Agent ID from the backend setup.
- Target repositories as `owner/repo`, one per line.
- Optional GitHub installation ID and GitHub MCP vault ID before dispatching real Tasks.

Submit the form. The Mission starts as `draft`; use the Mission page to plan and start it.

## 8. Trigger a Tick

With `pnpm dev` still running, there's no scheduled tick locally. Use the Console's manual "Run tick now" button on the Mission page, or invoke the route directly:

```bash
curl -X POST http://localhost:3100/api/tick
```

Local unauthenticated requests to `/api/tick` are allowed by setting `TICK_ALLOW_UNAUTHENTICATED=true` in `apps/web/.env.local` — for local curl testing only.

## 9. Watch Mission Control

Open the Mission from `http://localhost:3100/missions`. Mission Control shows task status, ledger activity, budget state, and links to deeper task or ledger views. Trigger the manual tick again (or curl `/api/tick`) to advance queued work.

## 10. Subscribe the GitHub App to pull request events

**Manual step — there is no API for it.** GitHub exposes an App's event
subscriptions only through its settings UI, so this cannot be scripted and is not
covered by the App manifest used at first registration.

Go to `https://github.com/settings/apps/<your-app-slug>` → **Permissions &
events** → **Subscribe to events**, tick **Pull request** and **Pull request
review**, and save.

Verify from the API rather than trusting the UI. Save as `check-events.mjs` and
run it from the repo root:

```js
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('apps/web/.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const pem = (env.GITHUB_APP_PRIVATE_KEY ?? '').replace(/^"|"$/g, '').replaceAll('\\n', '\n');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })}`;
const jwt = `${input}.${createSign('RSA-SHA256').update(input).sign(pem).toString('base64url')}`;
const res = await fetch('https://api.github.com/app', {
  headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
});
console.log('events:', ((await res.json()).events ?? []).join(', '));
```

The output must contain both `pull_request` and `pull_request_review`.

**What breaks without it.** Forge never learns that a PR it opened was merged or
closed by a human, and never records a review decision. Concretely: a Task a
human merges on GitHub is not marked `merged`; `tasks.reviewDecision` stays null
for every Task, so the Review step in the merge stepper shows "in progress"
indefinitely.

**What does not break.** Nothing wedges. The reconciler's merge-stall sweep polls
GitHub directly for Tasks in `merging` and `ready_to_merge`, so armed auto-merges
still resolve and stalled ones still escalate. The webhook is a latency
optimisation over that sweep, never the sole mechanism — deliberately, because a
subscription an operator must remember to tick cannot be load-bearing.

Also confirm the webhook itself is **Active** and points at your deployment
(`https://<your-host>/api/forge/github/webhook`) in the same settings page. An
App registered from `localhost` gets an inactive placeholder hook URL, which
silently delivers nothing.

## 11. Production: make `X-Forwarded-For` trustworthy

**This is an infrastructure step. Forge cannot do it for you, and until it is
done the auth rate limits are per-attacker-chosen-string, not per-client.**

Every rate limit on `/api/auth/*` — the unauthenticated, row-creating
`/api/auth/device/code`, the password-guessing budget on `/api/auth/sign-in/*`,
all of them — is keyed on the client IP, and the client IP is read from the
**first** element of the `X-Forwarded-For` request header.

Cloud Run, which `.github/workflows/deploy.yml` deploys straight to with
`--allow-unauthenticated` and nothing in front, **appends** to that header
rather than overwriting it. So the header a caller sends survives, in first
position, with the real client address appended after it:

```
# what the caller sends
X-Forwarded-For: 198.51.100.1
# what the app receives
X-Forwarded-For: 198.51.100.1, <real client address>
```

Two consequences:

1. **The limiter's key is caller-chosen.** Rotating that first element gives a
   fresh bucket per request, so a per-IP limit is not a per-client limit.
2. **A first element that is not a valid IP used to switch limiting off
   entirely** — better-auth's `getIp` returns null, and its limiter treats "no
   IP" as "cannot limit, so don't". `X-Forwarded-For: x` was enough. Forge now
   refuses such a request with a `429` at the route boundary
   (`apps/web/src/lib/auth-rate-limit.ts`) rather than serving it unlimited.
   That closes the "no limit at all" outcome. It does **not** fix (1).

**The real fix** is a load balancer or WAF between the internet and Cloud Run
that *overwrites* `X-Forwarded-For` with the address it observed, so the first
element is the peer address and not a caller-supplied string. On GCP:

- Put an **external HTTP(S) Application Load Balancer** in front of the Cloud
  Run service with a serverless NEG backend, and restrict the service's ingress
  to `internal-and-cloud-load-balancing` so it cannot be reached directly at
  its `*.run.app` URL (a direct hit bypasses the balancer and everything below
  it). `gcloud run services update <svc> --ingress=internal-and-cloud-load-balancing`.
- Attach a **Cloud Armor** security policy to that backend. Cloud Armor's
  own rate-limiting rules key on the connection's source address, which no
  header can influence, so put the hard per-IP limits there rather than
  relying on the application's.
- Only after the balancer is in place, revisit
  `advanced.ipAddress.ipAddressHeaders` in `apps/web/src/lib/auth.ts`. Do not
  add a header (`x-real-ip`, `cf-connecting-ip`, …) before there is a proxy
  that is guaranteed to set it: naming a header nothing writes makes the key
  fully attacker-supplied.

**What does not break without it.** The `deviceCode` table cannot grow without
bound: `apps/web/src/server/tick/device-codes.ts` sweeps every expired row on
each tick, independent of whether the limiter held. The limiter is a cost
control, never the sole mechanism — deliberately, because a header the platform
does not guarantee cannot be load-bearing.

## 12. Device authorization (CLI sign-in)

Forge implements the RFC 8628 device grant so a command-line tool can obtain an
API token. `POST /api/auth/device/code` returns a `user_code`, the human enters
it at `https://<your-host>/device`, and the CLI polls
`POST /api/auth/device/token` until it receives one.

### If you are writing a CLI: print `verification_uri`, never `verification_uri_complete`

The `/device/code` response contains both:

```jsonc
{
  "user_code": "ABCD-2345",
  "verification_uri": "https://<your-host>/device",
  "verification_uri_complete": "https://<your-host>/device?user_code=ABCD-2345", // do not print this
  "device_code": "...",
  "interval": 5,
  "expires_in": 300
}
```

`verification_uri_complete` carries the user code **in a URL**, and a URL is the
most-copied value in any system. It lands in shell history, terminal scrollback,
CI job logs, proxy and load-balancer access logs, browser history, and — if the
consent page ever links anywhere — the `Referer` header of the next request.

The consequence is not the obvious one. Anyone who reads that code inside its
lifetime can open `/device`, enter it, and approve it **as themselves**. The
waiting CLI then receives a session in the *reader's* account, not the victim's:
the victim's terminal is now signed in as someone else, and everything they do
with it happens in that account. That is session fixation, and the direction of
the harm makes it easy to miss.

Forge cannot fix this for you. The plugin offers no option to suppress
`verification_uri_complete`, and the consent page ignoring the `?user_code=`
parameter does not help — the leak already happened at the HTTP layer, before
any page ran. The only fix is on the CLI side:

```
# Correct
Open https://<your-host>/device and enter the code:  ABCD-2345

# Wrong — puts the code in every log that sees this URL
Open https://<your-host>/device?user_code=ABCD-2345
```

Two supporting measures already in place: codes expire after 5 minutes
(`expiresIn` in `apps/web/src/lib/auth.ts`), which bounds how long a leaked code
is worth acting on, and the consent page never pre-fills the field from the URL,
so a link cannot turn approval into a single click.

### What approving a device code actually grants

A full, unrestricted session — the same power the user has in the browser.
There are no scopes: `/api/auth/device/token` issues an ordinary session token,
so a scoped request is rejected outright rather than being stored and echoed
back as a restriction nothing enforces
(`rejectDeviceScope`, `apps/web/src/lib/device-auth.ts`).

### The phishing case, stated plainly

Requiring the human to type the code does **not** prove they started the flow.
`/api/auth/device/code` needs no authentication, so anyone can obtain a code and
then ask a user to enter it: *"Forge needs you to re-authorize — go to
https://\<your real host\>/device and enter ABCD-2345."* The link is the genuine
site, there is no lookalike domain and no query parameter, and the client
allow-list guarantees the consent screen displays a name the user trusts. If
they approve, the attacker's poll returns a session as them.

This is RFC 8628 §5.1 remote phishing. It is inherent to the device grant, not
specific to this implementation, and no server-side check on the consent page
can distinguish it from a legitimate approval. What Forge does about it:

- The consent screen states that the grant is full access and asks directly
  whether the user started the sign-in, rather than implying the code proved it.
- **`/sessions` lists every live session in the account and ends any of them.**
  A session issued by this flow carries the polling CLI's IP address and user
  agent rather than a browser's, which is usually how you spot one. This is the
  remediation path — tell your users about it.
- The code lifetime is 5 minutes.

Operators supporting users should treat "someone asked me to enter a code" as a
reportable event, and the response is: reject it, then check `/sessions`.

### Adding a second trusted client

`client_id` is checked against an exact-match allow-list containing only
`forge-cli` by default. To add another, set `FORGE_DEVICE_CLIENT_IDS` to a
comma-separated list (include `forge-cli` if you still want it). The name is
shown to the user on the consent screen as the thing they are authorizing, so
add nothing you would not vouch for.
