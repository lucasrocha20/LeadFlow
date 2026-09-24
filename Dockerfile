# syntax=docker/dockerfile:1
# One image for both processes (API: `node dist/server.js`, the default; worker:
# `node dist/worker.js`), plus a `release` target that runs migrations and the seed before
# each deploy. See docs/deploy.md.

FROM node:22-bookworm-slim AS base
WORKDIR /app

# Full install (dev tools included), then compile. The postinstall generates the Prisma client
# into src/generated, which the build compiles into dist/.
FROM base AS build
# Prisma's migration engine (release target) needs OpenSSL, which the slim image lacks.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Release step: apply migrations and create missing default templates/sequences. Idempotent;
# run it once per deploy, before starting the new API and worker.
FROM build AS release
ENV NODE_ENV=production
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed"]

# Production dependencies only. Scripts are skipped: the Prisma client is already compiled
# into dist/, and the runtime needs no native builds. Optional packages are omitted too:
# @prisma/client's optional peers (the Prisma CLI, TypeScript) would add ~300 MB of tooling,
# and the others (msgpackr-extract, pg-cloudflare) are unused speed-ups/platform shims.
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
