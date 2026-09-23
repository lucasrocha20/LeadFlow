# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

LeadFlow automates lead follow-up: capture → qualification → immediate contact → scheduled follow-up → CRM update. The design and phased roadmap are in `.claude/PLAN.md`. Read it before starting a new phase, and mark phases done there when they're complete. Phases 0–4 are done: scaffolding, capture, qualification, first contact, and follow-up/replies.

Stack: TypeScript (ESM, NodeNext) on Node ≥20, Fastify 5, PostgreSQL via Prisma 7, Redis + BullMQ (via ioredis), Zod 4, Vitest, npm.

## Commands

```bash
docker compose up -d --wait        # Postgres + Redis (host ports from POSTGRES_PORT / REDIS_PORT in .env)
npm run db:migrate                 # prisma migrate dev (create/apply migrations)
npm run db:generate                # regenerate Prisma client (also runs on postinstall)
npm run db:seed                    # create missing default templates and follow-up sequences (the worker needs them)
npm run dev                        # API: tsx watch, loads .env
npm run dev:worker                 # background worker (consumes queues), loads .env
npm run build && npm start         # compile to dist/ and run the API (npm run start:worker for the worker)
npm run lint                       # eslint
npm run format / format:check      # prettier
npm run typecheck                  # tsc --noEmit (covers src + test)
npm test                           # vitest run (test/db is skipped unless DATABASE_URL is set)
npm run test:db                    # DB/Redis-backed tests (serial), loads .env; needs docker compose up + migrations
npx vitest run test/health.test.ts # single file
npx vitest run -t "returns 503"    # single test by name
```

CI (`.github/workflows/ci.yml`) runs prisma validate, lint, format:check, typecheck, test and build. It needs no database.

## Architecture and conventions

- **Entry points:** `src/server.ts` (the API) and `src/worker.ts` (the BullMQ workers, a separate process) wire real dependencies (config, Prisma, Redis) and handle graceful shutdown. `src/app.ts` exports `buildApp(deps)`, which takes its dependencies as arguments so tests can build the app with fakes and call `app.inject()`, with no DB or network. Keep this split: construct external clients in `server.ts` (or future worker entry points) and pass them in.
- **Config:** `src/config.ts` validates `process.env` with Zod and fails at startup with a readable error. Add every new env var there and to `.env.example`.
- **Capture (`src/capture/`):** `POST /webhooks/forms/:provider` (`src/routes/webhooks.ts`) looks up a `FormAdapter` (`verify` + `normalize → LeadInput`), then calls `captureLead`. That call dedupes, merges, writes the lead plus a `captured` event in one transaction, and enqueues `lead.captured`. To add a provider, write an adapter in `src/capture/adapters/`, register it in `createFormAdapters` behind its secret, and add a fixture test. The webhook plugin parses JSON into a Buffer (`request.rawBody`) so signatures can be checked against the exact bytes.
- **Qualification (`src/qualification/`):** `rules.ts` validates the JSON rules (`config/scoring.json`). `engine.ts` is pure: `scoreLead(lead, rules)` returns the score, tier, matched rules and disqualifiers. `qualifyLead.ts` handles the `lead.captured` job: it locks the lead row, scores it, writes a `scored` event, and enqueues `lead.qualified`. To change scoring, edit the JSON rather than code. Every rule in the default file needs a matching/non-matching case in `test/scoring-engine.test.ts`, and a test enforces this.
- **Contact (`src/contact/`):** `planFirstContact.ts` handles `lead.qualified` and enqueues one `message.send` job per message (with a quiet-hours delay). `sendMessage.ts` handles `message.send`: it re-checks eligibility (`eligibility.ts`), renders the DB template, calls the channel's adapter, and records `message_sent` / `rep_notified` / `message_failed`. Adapters (`adapters/`) implement `MessageAdapter.send`. They throw `PermanentSendError` for failures that retrying won't fix (anything else is retried) and take `fetch` as a parameter so tests can check the requests. To add a provider, add an adapter, a `*_PROVIDER` enum value with its required credentials in `config.ts`, and a case in `createMessageAdapters`.
- **Follow-up (`src/followup/`):** `enrollLead` runs inside the first-contact transaction in `sendMessage`. `runStep.ts` handles `followup.step`: it locks the enrollment, stops it if the lead isn't contactable, queues the step's `message.send` (kind `follow_up`), and advances `currentStep`/`nextRunAt`. Past the last step it completes the enrollment and sets `unresponsive`. `reconcileEnrollments` rebuilds step jobs from `nextRunAt`; the worker runs it at startup and every 10 minutes.
- **Inbound (`src/inbound/`, routes in `src/routes/replies.ts` and `unsubscribe.ts`):** `ReplyAdapter` (`verify` + `parse → InboundMessage[]`) per provider. `handleInbound` records the reply, then either calls `optOutInTx` (keyword) or stops sequences, sets `engaged` and alerts the rep. `createOptOut` backs the unsubscribe link. Anything that stops contact must go through `optOutInTx`/`stopEnrollments` so the events are recorded. Queued messages rely on the send-time status check.
- **Idempotency pattern:** each stage writes its event with a unique `LeadEvent.dedupeKey` derived from its input (`<source>:<externalId>`, `scored:<captured event id>`, `first-contact:<lead>:<channel>`, `follow-up:<enrollment>:<step>`, `reply:<channel>:<provider message id>`), catches the unique violation for concurrent duplicates, and enqueues the next job with the event id as the job id. A retry after a failed enqueue therefore just enqueues again. Follow the same pattern in later stages.
- **Queue (`src/queue.ts`):** the app only sees the `JobQueue` interface. BullMQ queues are created in `server.ts` on an ioredis client with `enableOfflineQueue: false`, so a request fails fast when Redis is down. Job ids come from event ids, which makes re-enqueueing idempotent. Pass `onError` to `createJobQueue`, because BullMQ prints unhandled queue errors to stderr. The worker's own connection uses `maxRetriesPerRequest: null`, as BullMQ requires.
- **Tests:** build test apps with `testAppDeps({...})` and queues with `fakeQueue()` from `test/helpers.ts`. DB tests create their own templates/sequences with unique names and pass them in via config, so they don't depend on seeded data.
- **Health:** `/health` is liveness (always 200). `/health/ready` runs the named `readinessChecks` passed to `buildApp` and returns 503 if any fails. Database and Redis are registered.
- **Prisma 7 specifics:** the connection URL comes from `prisma.config.ts`, not the schema. The client is generated into `src/generated/prisma` (gitignored) and imported from `./generated/prisma/client.js`. At runtime it uses the `@prisma/adapter-pg` driver adapter (`src/db.ts`).
- **Data model** (`prisma/schema.prisma`): `Lead`, `LeadEvent` (append-only audit trail and the source for CRM sync, so never update or delete events), `Sequence`/`SequenceStep`/`Template` (follow-up config stored as data; `SequenceStep.offsetMinutes` counts from enrollment), `Enrollment` (per-lead sequence progress, where `nextRunAt` persists the schedule).
- **Imports:** relative imports must use the `.js` extension (NodeNext ESM). Use `import type` for type-only imports (`verbatimModuleSyntax`).

## Gotchas

- `prisma migrate dev` refuses to run in a non-interactive shell (such as Claude's). To create a migration there, write the SQL with `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o prisma/migrations/<timestamp>_<name>/migration.sql`, then run `npx prisma migrate deploy`.
- BullMQ custom job ids can't contain `:`. Use `messageJobId()` (or similar) when deriving a job id from a dedupe key.
- `ALTER TYPE … ADD VALUE` (a new `LeadEventType`) can't run inside a transaction together with statements that use the new value. Keep enum additions in their own migration.
- `msgpackr-extract` (an optional native dependency of BullMQ) has an install script that is deliberately not approved. msgpackr falls back to pure JS.
- The `prisma` npm `latest` tag pointed at an 8.0 release candidate when this was set up. Keep `prisma` and `@prisma/client` on the same stable version, and don't upgrade to 8.x without a deliberate migration.
- npm's `allowScripts` in `package.json` gates install scripts. Only `@prisma/engines`, `prisma` and `esbuild` are approved. New packages with install scripts need `npm approve-scripts <pkg>`.
- On this machine, another project already uses ports 5432, 6379 and 3000. The local `.env` uses 5433, 6380 and 3001, while `.env.example` keeps the defaults.
