import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { deviceCode } from '@forge/db/schema';

import { AUTH_IP_ADDRESS_HEADERS } from './auth-rate-limit';
import { db } from './db';
import { isAllowedDeviceClient, rejectDeviceScope } from './device-auth';
import { env } from './env';

// better-auth's schema — must match migration 0004_auth_tables.sql.
// The drizzle adapter requires the schema passed explicitly because our
// db instance was created with @forge/db's schema (missions/tasks/ledger),
// not better-auth's tables.
const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: integer('emailVerified').notNull().default(0),
  image: text('image'),
  createdAt: integer('createdAt').notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updatedAt').notNull().default(sql`(unixepoch() * 1000)`),
}, (t) => [uniqueIndex('user_email_unique').on(t.email)]);

const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expiresAt').notNull(),
  token: text('token').notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: integer('createdAt').notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updatedAt').notNull().default(sql`(unixepoch() * 1000)`),
}, (t) => [uniqueIndex('session_token_unique').on(t.token)]);

const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: integer('accessTokenExpiresAt'),
  refreshTokenExpiresAt: integer('refreshTokenExpiresAt'),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('createdAt').notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updatedAt').notNull().default(sql`(unixepoch() * 1000)`),
});

const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expiresAt').notNull(),
  createdAt: integer('createdAt').notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updatedAt').notNull().default(sql`(unixepoch() * 1000)`),
});

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, {
    provider: 'sqlite',
    schema: { user, session, account, verification, deviceCode },
  }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    github: {
      clientId: env.GITHUB_CLIENT_ID ?? '',
      clientSecret: env.GITHUB_CLIENT_SECRET ?? '',
    },
  },
  // bearer converts `Authorization: Bearer <token>` into the session cookie
  // better-auth already understands, so apiAuth()/withAuth() need no change
  // and every ownership check keeps working against a real user session.
  //
  // `requireSignature` is deliberately left off. For a token containing no
  // `.` — exactly the shape of `session.token` — the plugin signs the value
  // itself with the server secret and then verifies its own signature, so the
  // check can never fail and buys nothing; the DB lookup on `session.token` is
  // the real gate. Turning it on would reject the raw session tokens the
  // device flow issues, so it cannot be enabled on its own — it would have to
  // land together with a change to what that flow returns. This is a
  // considered trade-off, not an oversight.
  //
  // `deviceAuthorization()` — the `gh auth login` flow a CLI uses to obtain a
  // token — was unregistered in 45fcbdf because three things were true of it
  // in 1.6.9, and is back now that all three are answered. Each answer is
  // load-bearing; do not remove one because it looks like configuration.
  //
  //   1. `deviceApprove` guarded ownership with
  //      `if (record.userId && record.userId !== session.user.id)`, which
  //      cannot fire on a freshly created row (`userId` is NULL). Any
  //      logged-in user's approval therefore bound the row to themselves and
  //      `/device/token` handed the code-holder a full session for that user.
  //      ANSWER: `/device/approve` and `/device/deny` are switched off in
  //      `disabledPaths` below, and approval goes through
  //      `decideDeviceRequest` (lib/device-auth.ts) — a compare-and-swap on
  //      `status = 'pending'` driven by the consent page at /device. The CAS
  //      is what makes the first decision final, so a row bound to one user
  //      can never be rebound to another. The consent page additionally
  //      requires the human to type the user code, and requires the decision
  //      to carry an HMAC minted by that lookup, so approving is a two-step
  //      act by a signed-in human and not a single request.
  //
  // ── What typing the code does and does not prove ──────────────────────
  //
  // Be precise about this, because an earlier version of this comment said
  // the typing "proves the person approving is the person who started the
  // flow", and the decision to re-register the plugin appeared to rest on
  // that. It is not true, and leaving it written down means the next reader
  // re-derives a guarantee that does not exist.
  //
  //   IT DOES defeat the one-click variant. `verification_uri_complete`
  //     carries `?user_code=…` and there is no option to suppress it. A
  //     crafted link that pre-fills the field turns approval into one click
  //     on a screen the human never read. The consent page ignores that
  //     parameter, so there is always a code to type and always a screen
  //     naming the client before anything is granted. That is real and
  //     worth keeping.
  //
  //   IT DOES NOT prove the approver started the flow. Typing the code
  //     proves the person KNOWS the code — and the attacker generated it,
  //     so the attacker can simply tell them. `/device/code` needs no auth:
  //     get a code, message the victim "Forge needs you to re-authorize, go
  //     to https://<real-forge-host>/device and enter ABCD-2345", and every
  //     anti-prefill measure here is untouched, because the link is the
  //     genuine site with no query parameter. The `client_id` allow-list
  //     even guarantees the screen shows a name the victim trusts. This is
  //     RFC 8628 §5.1 remote phishing: inherent to the device grant, not
  //     introduced by this implementation, and not closable on the consent
  //     page — no server-side check can distinguish a human who was talked
  //     into typing a code from one who read it off their own terminal.
  //
  // So the phishing case is mitigated, not prevented, and the mitigation is
  // that the grant is visible and reversible: /sessions (lib/sessions.ts)
  // lists every live session in the account — one issued by this flow
  // carries the polling CLI's IP and user agent rather than a browser's —
  // and ends any of them in one click. `expiresIn` below bounds how long a
  // code is worth acting on at all.
  //   2. `validateClient` was undefined, so any `client_id` was accepted and
  //      a row created for it.
  //      ANSWER: `isAllowedDeviceClient` — an exact-match allow-list, one
  //      first-party entry by default, extendable via FORGE_DEVICE_CLIENT_IDS.
  //      It runs before the row is created.
  //   3. `scope` was accepted, stored and echoed back, while `/device/token`
  //      returned an ordinary unscoped session — so a CLI asking for
  //      `missions:read` got a token that can delete the account.
  //      ANSWER: `rejectDeviceScope` fails any non-empty scope with a 400.
  //      Forge has no scopes; pretending otherwise is worse than refusing.
  //
  // `expiresIn` is 5m, down from the plugin's 30m default and from the 10m
  // this branch first shipped.
  //
  // The window it actually narrows is not the phishing one. An attacker who
  // is talking to the victim can mint a fresh code any time — `/device/code`
  // needs no auth — so shortening the lifetime costs them one request. What
  // it narrows is the window for someone who saw a code they cannot re-mint:
  // `verification_uri_complete` puts `?user_code=…` in the URL, so a CLI that
  // prints it leaks the code into request logs, shell history and `Referer`.
  // Anyone reading those can approve that code AS THEMSELVES, handing the
  // victim's CLI a session in the attacker's account — session fixation. That
  // reader is racing a clock they cannot reset, and halving the clock halves
  // their odds. (A CLI must print `verification_uri`, never
  // `verification_uri_complete`. See the note on `verificationUri` below and
  // docs/operator-setup.md §12.)
  //
  // 5m is not tight for a human: read a code off a terminal, open a browser,
  // sign in if needed, type eight characters. It is deliberately not tighter
  // — a budget people routinely miss trains them to rush the consent screen,
  // and that screen is the only thing standing between them and a full-access
  // grant.
  plugins: [
    bearer(),
    deviceAuthorization({
      expiresIn: '5m',
      interval: '5s',
      validateClient: isAllowedDeviceClient,
      onDeviceAuthRequest: rejectDeviceScope,
      // Absolute, so the value a CLI prints is right regardless of how the
      // request reached us.
      //
      // The plugin also derives `verification_uri_complete` from this by
      // appending `?user_code=…`, and there is no option to suppress it. Two
      // separate problems with that value, and only one of them is fixed
      // here:
      //   - a link that pre-fills the field makes approval one click. The
      //     consent page ignores the parameter, so this one is closed.
      //   - the code travels in a URL, and URLs end up in logs, history and
      //     `Referer`. That leak is at the HTTP layer, so the consent page
      //     ignoring the parameter does nothing about it. The only fix is
      //     for the CLI to print `verification_uri` and the code separately
      //     and never `verification_uri_complete` — documented for CLI
      //     authors in docs/operator-setup.md §12.
      verificationUri: `${env.BETTER_AUTH_URL}/device`,
    }),
  ],
  // `disabledPaths` is enforced by the router's `onRequest` — an exact-string
  // `includes` against the normalized pathname, so `/device` switches off the
  // plugin's `deviceVerify` endpoint WITHOUT touching `/device/code` or
  // `/device/token`, and the 404 is returned before anything else runs. It
  // closes the HTTP surface `toNextJsHandler(auth)` mounts; it does NOT touch
  // `auth.api`, which is why auth-call-sites.test.ts exists.
  //
  //   /device/approve, /device/deny — the endpoints whose ownership guard
  //     cannot fire on a fresh row (see the numbered note above). Forge
  //     approves through `decideDeviceRequest` instead.
  //   /device — `deviceVerify`: `GET /api/auth/device?user_code=…`, no session
  //     required, answering `{user_code, status}` and distinguishing
  //     not-found / expired / pending / approved / denied. That is a free
  //     unauthenticated confirmation oracle for a secret: it tells anyone
  //     holding a guessed or observed code whether it is real, still live, and
  //     whether a human has acted on it yet. Nothing in Forge calls it — the
  //     CLI learns the outcome from `/device/token`, and the consent page uses
  //     `findDeviceRequest` — so it is pure attack surface.
  disabledPaths: ['/device', '/device/approve', '/device/deny'],
  rateLimit: {
    customRules: {
      // Unauthenticated and row-creating: the tightest of the three.
      '/device/code': { window: 60, max: 10 },
      // The CLI's polling endpoint. At the 5s interval above a well-behaved
      // client makes 12 requests a minute, so this is roughly five concurrent
      // sign-ins from one address before it bites; the plugin's own
      // `slow_down` response handles a client that polls faster than it said
      // it would.
      '/device/token': { window: 60, max: 60 },
      // There is deliberately no `/device` rule. That path is in
      // `disabledPaths`, and `onRequest` returns 404 for a disabled path
      // *before* it consults the limiter — so a rule there would be dead
      // config that reads like a live control.
    },
  },
  advanced: {
    // Pinned rather than left implicit, and pinned to the documented default
    // on purpose.
    //
    // better-auth keys its limiter on `getIp`, which takes the FIRST element
    // of the first header in this list. Behind Cloud Run (the deploy target
    // — see .github/workflows/deploy.yml, which deploys straight to a
    // *.run.app URL with --allow-unauthenticated and no load balancer or
    // Cloud Armor in front) the first element of `X-Forwarded-For` is
    // whatever the caller sent, so that key is spoofable and per-IP limiting
    // can be evaded by rotating it. Nothing in this repo documents a proxy
    // that guarantees a trustworthy header, and naming one that doesn't
    // exist would be worse.
    //
    // Worse specifically because of what `getIp` does when nothing parses: it
    // returns null, `resolveRateLimitConfig` returns null, and rate limiting
    // is skipped for that request ENTIRELY — every rule below included.
    // Cloud Run appends to `X-Forwarded-For`, so `X-Forwarded-For: x` arrives
    // as `x, <real ip>` and the first element is invalid. That was one header
    // away, not hypothetical. It is closed at the route boundary by
    // `guardRateLimitEvasion` (lib/auth-rate-limit.ts), which refuses a
    // request whose client IP cannot be resolved instead of letting it
    // through unlimited — the skip happens inside better-auth's `onRequest`,
    // before `customRules` are read, so it could not be closed from here.
    //
    // The array below is imported rather than written out so the guard and
    // the limiter can never key on different headers.
    //
    // So this remains the safe default, not a fix for spoofability. The
    // durable defence against an unbounded `deviceCode` table is the sweep in
    // server/tick/device-codes.ts, which does not depend on the limiter
    // holding. Revisit this the moment a load balancer lands in front of the
    // service and can be configured to overwrite the header — see
    // docs/operator-setup.md.
    ipAddress: { ipAddressHeaders: [...AUTH_IP_ADDRESS_HEADERS] },
  },
});

export type Auth = typeof auth;
