import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { deviceCode } from '@forge/db/schema';

import { db } from './db';
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
  // `deviceAuthorization()` (the `gh auth login` flow a CLI uses to obtain a
  // token) is deliberately NOT registered. `toNextJsHandler(auth)` mounts the
  // whole better-auth router publicly, so registering it puts `device/code`,
  // `device/token`, `device`, `device/approve` and `device/deny` live at once,
  // and in 1.6.9 all three of these hold:
  //   1. `deviceApprove` guards ownership with
  //      `if (record.userId && record.userId !== session.user.id)`. A fresh
  //      row has `userId` NULL, so the guard never fires and any logged-in
  //      user's approval binds the row to themselves — handing the
  //      code-holder a full session for that user.
  //   2. `validateClient` is undefined, so `client_id` is unvalidated and any
  //      string is accepted.
  //   3. `scope` is accepted, stored and echoed back, but `/device/token`
  //      returns an ordinary unscoped session. A CLI asking for
  //      `missions:read` gets a token that can delete the account.
  // Nothing supplies the missing proof, because the consent page that would
  // name the client and require the human to type the code does not exist —
  // `verification_uri_complete` points at a 404.
  //
  // Three preconditions must ALL be met before it goes back in:
  //   a. a consent page exists at the verification URI that names the
  //      requesting client and requires the human to enter the user code;
  //   b. `validateClient` is supplied with an allow-list of known client ids;
  //   c. `scope` is either actually enforced on the issued credential or
  //      rejected outright rather than silently ignored.
  // The `deviceCode` table stays in the schema so re-enabling needs no
  // migration — but re-enabling must be a deliberate act, not a one-line
  // revert of this comment.
  plugins: [bearer()],
});

export type Auth = typeof auth;
