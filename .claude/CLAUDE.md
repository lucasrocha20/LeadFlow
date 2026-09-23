# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

LeadFlow automates lead follow-up: capture → qualification → immediate contact → scheduled follow-up → CRM update. The design and phased roadmap are in `.claude/PLAN.md`. Read it before starting a new phase, and mark phases done there when they're complete. Phase 0 (scaffolding) is done.

Stack: TypeScript (ESM, NodeNext) on Node ≥20, Fastify 5, PostgreSQL via Prisma 7, Redis (for BullMQ, not wired up yet), Zod 4, Vitest, npm.

## Commands

```bash
docker compose up -d --wait        # Postgres + Redis (host ports from POSTGRES_PORT / REDIS_PORT in .env)
npm run db:migrate                 # prisma migrate dev (create/apply migrations)
npm run db:generate                # regenerate Prisma client (also runs on postinstall)
npm run dev                        # tsx watch, loads .env
npm run build && npm start         # compile to dist/ and run
npm run lint                       # eslint
npm run format / format:check      # prettier
npm run typecheck                  # tsc --noEmit (covers src + test)
npm test                           # vitest run
npx vitest run test/health.test.ts # single file
npx vitest run -t "returns 503"    # single test by name
```

CI (`.github/workflows/ci.yml`) runs prisma validate, lint, format:check, typecheck, test and build. It needs no database.

## Architecture and conventions

- **Entry points:** `src/server.ts` wires real dependencies (config, Prisma client) and handles graceful shutdown. `src/app.ts` exports `buildApp(deps)`, which takes its dependencies as arguments so tests can build the app with fakes and call `app.inject()`, with no DB or network. Keep this split: construct external clients in `server.ts` (or future worker entry points) and pass them in.
- **Config:** `src/config.ts` validates `process.env` with Zod and fails at startup with a readable error. Add every new env var there and to `.env.example`.
- **Health:** `/health` is liveness (always 200). `/health/ready` runs the named `readinessChecks` passed to `buildApp` and returns 503 if any fails. Register Redis here once it's used.
- **Prisma 7 specifics:** the connection URL comes from `prisma.config.ts`, not the schema. The client is generated into `src/generated/prisma` (gitignored) and imported from `./generated/prisma/client.js`. At runtime it uses the `@prisma/adapter-pg` driver adapter (`src/db.ts`).
- **Data model** (`prisma/schema.prisma`): `Lead`, `LeadEvent` (append-only audit trail and the source for CRM sync, so never update or delete events), `Sequence`/`SequenceStep`/`Template` (follow-up config stored as data), `Enrollment` (per-lead sequence progress, where `nextRunAt` persists the schedule).
- **Imports:** relative imports must use the `.js` extension (NodeNext ESM). Use `import type` for type-only imports (`verbatimModuleSyntax`).

## Gotchas

- The `prisma` npm `latest` tag pointed at an 8.0 release candidate when this was set up. Keep `prisma` and `@prisma/client` on the same stable version, and don't upgrade to 8.x without a deliberate migration.
- npm's `allowScripts` in `package.json` gates install scripts. Only `@prisma/engines`, `prisma` and `esbuild` are approved. New packages with install scripts need `npm approve-scripts <pkg>`.
- On this machine, another project already uses ports 5432, 6379 and 3000. The local `.env` uses 5433, 6380 and 3001, while `.env.example` keeps the defaults.
