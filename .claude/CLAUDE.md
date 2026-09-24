# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

LeadFlow automates lead follow-up: capture → qualification → immediate contact → scheduled follow-up → CRM update. The design and phased roadmap are in `.claude/PLAN.md`. Read it before starting a new phase, and mark phases done there when they're complete. Phases 0–7 are done: scaffolding, capture, qualification, first contact, follow-up/replies, CRM sync (HubSpot), operations (admin API, metrics, alerts, Bull Board), and hardening (rate limiting, consent ledger, erasure/retention, E2E test, Docker). The Phase 7 pilot is an operational step: see the checklist in `docs/deploy.md`, which is also the deploy runbook.

Stack: TypeScript (ESM, NodeNext) on Node ≥20, Fastify 5, PostgreSQL via Prisma 7, Redis + BullMQ (via ioredis), Zod 4, Vitest, npm.

## Commands

```bash
docker compose up -d --wait        # Postgres + Redis (host ports from POSTGRES_PORT / REDIS_PORT in .env)
npm run db:migrate                 # prisma migrate dev (create/apply migrations)
npm run db:generate                # regenerate Prisma client (also runs on postinstall)
npm run db:seed                    # create missing default templates and follow-up sequences (the worker needs them)
npm run crm:requeue [-- <leadId>…]  # retry dead-lettered CRM syncs (all, or the given leads)
npm run dev                        # API: tsx watch, loads .env
npm run dev:worker                 # background worker (consumes queues), loads .env
npm run build && npm start         # compile to dist/ and run the API (npm run start:worker for the worker)
npm run lint                       # eslint
npm run format / format:check      # prettier
npm run typecheck                  # tsc --noEmit (covers src + test)
npm test                           # vitest run (test/db is skipped unless DATABASE_URL is set)
npm run test:db                    # DB/Redis-backed tests (serial), incl. test/db/e2e.test.ts; loads .env if present; needs docker compose up, migrations and db:seed
npx vitest run test/health.test.ts # single file
npx vitest run -t "returns 503"    # single test by name
```

CI (`.github/workflows/ci.yml`) has three jobs. `check` runs prisma validate, lint, format:check, typecheck, unit tests and the build, with no database. `db` runs Postgres and Redis service containers, then migrate deploy, seed, a schema drift check and `test:db`. `docker` builds both image targets.

```bash
docker build --target runtime -t leadflow .          # API (default CMD) and worker (`node dist/worker.js`)
docker build --target release -t leadflow-release .  # migrate deploy + seed; run before each deploy
```

## Architecture and conventions

- **Entry points:** `src/server.ts` and `src/worker.ts` are thin. They load config, open the Postgres and Redis connections, and handle shutdown. The wiring lives in `createApi()` (`src/api.ts`: every route's real dependencies) and `startPipeline()` (`src/pipeline.ts`: one BullMQ worker per queue, plus the periodic reconcile, CRM sweep, alerts and retention tasks). Both take an optional BullMQ `prefix`, which is how `test/db/e2e.test.ts` runs the real thing on isolated queues. Underneath, `src/app.ts` exports `buildApp(deps)`, which takes its dependencies as arguments so unit tests can build the app with fakes and call `app.inject()`, with no DB or network.
- **Config:** `src/config.ts` validates `process.env` with Zod and fails at startup with a readable error. Add every new env var there and to `.env.example`.
- **Capture (`src/capture/`):** `POST /webhooks/forms/:provider` (`src/routes/webhooks.ts`) looks up a `FormAdapter` (`verify` + `normalize → LeadInput`), then calls `captureLead`. That call dedupes, merges, writes the lead plus a `captured` event in one transaction, and enqueues `lead.captured`. To add a provider, write an adapter in `src/capture/adapters/`, register it in `createFormAdapters` behind its secret, and add a fixture test. The webhook plugin parses JSON into a Buffer (`request.rawBody`) so signatures can be checked against the exact bytes.
- **Qualification (`src/qualification/`):** `rules.ts` validates the JSON rules (`config/scoring.json`). `engine.ts` is pure: `scoreLead(lead, rules)` returns the score, tier, matched rules and disqualifiers. `qualifyLead.ts` handles the `lead.captured` job: it locks the lead row, scores it, writes a `scored` event, and enqueues `lead.qualified`. To change scoring, edit the JSON rather than code. Every rule in the default file needs a matching/non-matching case in `test/scoring-engine.test.ts`, and a test enforces this.
- **Contact (`src/contact/`):** `planFirstContact.ts` handles `lead.qualified` and enqueues one `message.send` job per message (with a quiet-hours delay). `sendMessage.ts` handles `message.send`: it re-checks eligibility (`eligibility.ts`), renders the DB template, calls the channel's adapter, and records `message_sent` / `rep_notified` / `message_failed`. Adapters (`adapters/`) implement `MessageAdapter.send`. They throw `PermanentSendError` for failures that retrying won't fix (anything else is retried) and take `fetch` as a parameter so tests can check the requests. To add a provider, add an adapter, a `*_PROVIDER` enum value with its required credentials in `config.ts`, and a case in `createMessageAdapters`.
- **Follow-up (`src/followup/`):** `enrollLead` runs inside the first-contact transaction in `sendMessage`. `runStep.ts` handles `followup.step`: it locks the enrollment, stops it if the lead isn't contactable, queues the step's `message.send` (kind `follow_up`), and advances `currentStep`/`nextRunAt`. Past the last step it completes the enrollment and sets `unresponsive`. `reconcileEnrollments` rebuilds step jobs from `nextRunAt`; the worker runs it at startup and every 10 minutes.
- **Inbound (`src/inbound/`, routes in `src/routes/replies.ts` and `unsubscribe.ts`):** `ReplyAdapter` (`verify` + `parse → InboundMessage[]`) per provider. `handleInbound` records the reply, then either calls `optOutInTx` (keyword) or stops sequences, sets `engaged` and alerts the rep. `createOptOut` backs the unsubscribe link. Anything that stops contact must go through `optOutInTx`/`stopEnrollments` so the events are recorded. Queued messages rely on the send-time status check.
- **CRM (`src/crm/`):** pull-based. `findLeadsToSync` (worker sweep every 30s) → `crm.sync` job per lead → `syncLead` pushes the contact, the stage (`config/crm.json`) and every event past the lead's `crmSyncedThrough` cursor as an activity (`activity.ts` renders the text). `runCrmSyncJob` maps `CrmRateLimitError` to BullMQ's queue-wide rate limit and `CrmPermanentError` (or the last attempt) to the dead letter. Adapters throw those error classes. New event types need a case in `describeEvent`.
- **Admin (`src/admin/`, `src/routes/admin.ts`):** only served when `ADMIN_TOKEN` is set. All routes under `/admin` go through `adminAuth`, which accepts a bearer token or Basic auth (the password is the token), so the Bull Board UI at `/admin/queues` gets a browser prompt. The JSON API is under `/admin/api`: leads (keyset-paginated), lead timeline, enrollment pause/resume, queue stats, retry-failed, CRM requeue, metrics, alerts. Routes only see the `AdminService` interface (fake it with `fakeAdminService()`). `QueueMonitor` (`src/queue.ts`) is the read/repair side of the queues: the API and the worker each create one. Metrics (`metrics.ts`) are raw SQL over `LeadEvent`. Funnel metrics group leads by capture date, while send failures count by event time. Reply rate per step credits a reply to the latest touch before it, and reads the follow-up step from the `follow-up:<enrollment>:<step>` dedupe key.
- **Alerts (`src/admin/alerts.ts`):** the worker runs `evaluateAlerts`, then `notifyAlerts`, every minute. `alertsFrom` is the pure threshold logic. Redis (`redisAlertStore`) holds the cooldown and firing set, so several workers or a restart notify once, and a resolution is posted once. Notifications are always logged, and also posted to `ALERT_WEBHOOK_URL` (Slack `{text}`) when it's set. To add an alert, add its input to `evaluateAlerts` and its rule to `alertsFrom`.
- **HTTP hardening (`src/app.ts`):** `@fastify/rate-limit` applies a per-IP limit (`RATE_LIMIT_PER_MINUTE`) to every route except `/health*`. Its counters live in Redis and it fails open if Redis is down. `TRUST_PROXY` controls how the client IP is read from `X-Forwarded-For`. A numeric hop count is turned into a trust function, because Fastify's types reject numbers.
- **Privacy (`src/privacy/`):**
  - `consent.ts`: every capture writes a `ConsentRecord` for each granted purpose, with the adapter's `consentEvidence`. `optOutInTx` withdraws consent (records it and clears the flags).
  - `suppression.ts`: SHA-256 hashes of `email:`/`phone:` addresses. Capture calls `optOutInTx(…, 'suppression_list')` when an address is suppressed, for both new leads and merges.
  - `erasure.ts`: `eraseLeads` deletes the leads (events, enrollments and consents cascade), suppresses their addresses (all of them for `request`, only opted-out ones for `retention`) and writes an `Erasure` log without personal data. With a CRM, it first parks the sync (`crmSyncFailedAt`), then deletes the contacts, then erases, so a CRM failure erases nothing and a retry is safe. It takes capture's `lockContactKeys`, so a concurrent capture sees the suppression.
  - Admin routes: `POST /admin/api/privacy/export|erase` (erase requires `confirm: true`).
  - Retention: `DATA_RETENTION_DAYS`, run hourly by the pipeline.
- **Pausing:** `paused` enrollments are skipped by `runStep`, their queued follow-up messages are dropped at send time, and reconcile ignores them. `resumeEnrollment` reschedules an overdue step for now (a new `runAt`, so a new job id). Anything that stops enrollments must include `paused` (see `stopEnrollments`).
- **Idempotency pattern:** each stage writes its event with a unique `LeadEvent.dedupeKey` derived from its input (`<source>:<externalId>`, `scored:<captured event id>`, `first-contact:<lead>:<channel>`, `follow-up:<enrollment>:<step>`, `reply:<channel>:<provider message id>`), catches the unique violation for concurrent duplicates, and enqueues the next job with the event id as the job id. A retry after a failed enqueue therefore just enqueues again. Follow the same pattern in later stages.
- **Queue (`src/queue.ts`):** the app only sees the `JobQueue` interface. BullMQ queues are created in `server.ts` on an ioredis client with `enableOfflineQueue: false`, so a request fails fast when Redis is down. Job ids come from event ids, which makes re-enqueueing idempotent. Pass `onError` to `createJobQueue`, because BullMQ prints unhandled queue errors to stderr. The worker's own connection uses `maxRetriesPerRequest: null`, as BullMQ requires.
- **Tests:** build test apps with `testAppDeps({...})` and queues with `fakeQueue()` from `test/helpers.ts`. DB tests create their own templates/sequences with unique names and pass them in via config, so they don't depend on seeded data. The exception is `test/db/e2e.test.ts`, which deliberately runs the shipped config and seed. It uses its own BullMQ prefix, disables quiet hours, moves the CRM clock past `SYNC_LAG_MS`, and cleans up its leads, suppressions and Redis keys.
- **Health:** `/health` is liveness (always 200). `/health/ready` runs the named `readinessChecks` passed to `buildApp` and returns 503 if any fails. Database and Redis are registered.
- **Prisma 7 specifics:** the connection URL comes from `prisma.config.ts`, not the schema. The client is generated into `src/generated/prisma` (gitignored) and imported from `./generated/prisma/client.js`. At runtime it uses the `@prisma/adapter-pg` driver adapter (`src/db.ts`).
- **Data model** (`prisma/schema.prisma`):
  - `Lead`
  - `LeadEvent`: the append-only audit trail and the source for CRM sync. Never update or delete events, except when erasure deletes the whole lead.
  - `Sequence`/`SequenceStep`/`Template`: follow-up config stored as data. `SequenceStep.offsetMinutes` counts from enrollment.
  - `Enrollment`: per-lead sequence progress. `nextRunAt` persists the schedule.
  - `ConsentRecord`: the consent ledger.
  - `Suppression`: hashed addresses that must never be contacted.
  - `Erasure`: the erasure audit log.
- **Imports:** relative imports must use the `.js` extension (NodeNext ESM). Use `import type` for type-only imports (`verbatimModuleSyntax`).

## Gotchas

- `prisma migrate dev` refuses to run in a non-interactive shell (such as Claude's). To create a migration there, first run `npx prisma migrate deploy` (the diff is taken against the live database, so a database with pending migrations yields a migration that repeats them). Then write the SQL with `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o prisma/migrations/<timestamp>_<name>/migration.sql`, then run `npx prisma migrate deploy`.
- `LeadEvent.createdAt` (and every `@default(now())`) is the *transaction start* time, and events written in one transaction share it. Anything that reads events incrementally must lag behind (the CRM sync uses `SYNC_LAG_MS`) and break ties by id.
- BullMQ custom job ids can't contain `:`. Use `messageJobId()` (or similar) when deriving a job id from a dedupe key.
- `ALTER TYPE … ADD VALUE` (a new `LeadEventType`) can't run inside a transaction together with statements that use the new value. Keep enum additions in their own migration.
- `msgpackr-extract` (an optional native dependency of BullMQ) has an install script that is deliberately not approved. msgpackr falls back to pure JS.
- The Prisma generator pins `importFileExtension = "js"`. Without it, the output depends on whether a `tsconfig.json` exists when generating. The Docker build generates before copying it, which produced `./enums.ts` imports and a crashing image.
- The runtime image installs with `npm ci --omit=dev --omit=optional --ignore-scripts`. `@prisma/client` declares the Prisma CLI and TypeScript as *optional peers*, which the lockfile marks `devOptional`, so only `--omit=optional` keeps them (about 300 MB) out. `--omit=peer` doesn't. The Prisma client runs on the pure-JS `pg` adapter, so the runtime needs neither engines nor OpenSSL. Only the build/release stage installs OpenSSL, for the migration engine.
- The `prisma` npm `latest` tag pointed at an 8.0 release candidate when this was set up. Keep `prisma` and `@prisma/client` on the same stable version, and don't upgrade to 8.x without a deliberate migration.
- npm's `allowScripts` in `package.json` gates install scripts. Only `@prisma/engines`, `prisma` and `esbuild` are approved. New packages with install scripts need `npm approve-scripts <pkg>`.
- On this machine, another project already uses ports 5432, 6379 and 3000. The local `.env` uses 5433, 6380 and 3001, while `.env.example` keeps the defaults.
