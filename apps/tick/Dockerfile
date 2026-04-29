# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc* ./
COPY apps/tick/package.json apps/tick/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs tick
COPY --from=deps --chown=tick:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=tick:nodejs /app/apps/tick/node_modules ./apps/tick/node_modules
COPY --from=deps --chown=tick:nodejs /app/packages/db/node_modules ./packages/db/node_modules
COPY --chown=tick:nodejs apps/tick ./apps/tick
COPY --chown=tick:nodejs packages/db ./packages/db
USER tick
EXPOSE 8080
WORKDIR /app/apps/tick
CMD ["node", "--import", "tsx", "src/index.ts"]
