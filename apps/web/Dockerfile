# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc* ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=file:local.db
ENV BETTER_AUTH_SECRET=build-placeholder
RUN pnpm --filter @forge/web exec fumadocs-mdx && pnpm --filter @forge/web build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
# Copy native libsql bindings (not included in standalone output)
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.pnpm/libsql@*/node_modules/libsql ./node_modules/libsql
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.pnpm/@libsql+linux-x64-musl@*/node_modules/@libsql/linux-x64-musl ./node_modules/@libsql/linux-x64-musl
USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
