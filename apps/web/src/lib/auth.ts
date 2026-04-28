import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
  },
});

export type Auth = typeof auth;
