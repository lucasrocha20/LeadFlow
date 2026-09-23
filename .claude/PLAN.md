# PLAN.md — LeadFlow: Lead Follow-up Automation

Automatically capture, qualify and follow up on leads by connecting forms, a CRM, messaging (WhatsApp/SMS) and email.

## Pipeline

```
Lead
 ↓
Automatic capture      → form/webhook arrives and becomes a lead record
 ↓
Qualification          → score it and put it in a tier (hot / warm / cold / disqualified)
 ↓
Immediate contact      → first message within minutes, on a channel picked by tier
 ↓
Scheduled follow-up    → timed series of messages that stops when the lead replies
 ↓
CRM update             → every event is synced to the CRM (contact, stage, activity log)
```

## Proposed stack

The repo's `.gitignore` points to Node.js, so this plan assumes the choices below. Confirm them before scaffolding.

| Concern          | Choice                    | Why                                                   |
| ---------------- | ------------------------- | ----------------------------------------------------- |
| Language/runtime | TypeScript on Node.js LTS | Types across integration payloads                     |
| HTTP server      | Fastify                   | Fast, schema-validated webhooks                       |
| Database         | PostgreSQL + Prisma       | Leads, events, sequences, audit trail                 |
| Queue/scheduler  | Redis + BullMQ            | Delayed jobs for follow-ups, retries                  |
| Validation       | Zod                       | Normalize payloads that differ between form providers |
| Tests            | Vitest                    | Fast, TS-native                                       |
| Local infra      | Docker Compose            | Postgres + Redis                                      |

Every external platform sits behind an **adapter interface**, so providers can be swapped without touching the pipeline:

- **Forms:** website form, Typeform, Google Forms, Meta Lead Ads (webhooks)
- **CRM:** HubSpot or Pipedrive (start with one)
- **Messaging:** WhatsApp Cloud API or Twilio (WhatsApp/SMS)
- **Email:** Resend or SendGrid

## Architecture

```
[Form providers] --webhook--> [Capture API] --> [DB: leads, events]
                                   |
                                   v
                          [Queue: lead.captured]
                                   |
                                   v
                          [Qualification worker] --> score + tier
                                   |
                                   v
                          [Contact worker] --> Messaging / Email adapters
                                   |
                                   v
                          [Follow-up scheduler] --delayed jobs--> [Contact worker]
                                   |
         (every step emits an event) v
                          [CRM sync worker] --> CRM adapter

[Inbound replies (WhatsApp/email webhooks)] --> stop the sequence, mark lead "engaged", notify the rep
```

Design rules:

- **Event-driven:** each stage publishes a job for the next one, so stages stay independent and can be retried on their own.
- **Idempotent:** every inbound webhook has a dedupe key (provider + external id). Jobs can safely run more than once.
- **Append-only `lead_events` table:** this is the audit trail and the source for CRM activity sync.
- **Config over code:** scoring rules and follow-up sequences are stored as data (JSON/DB), not hardcoded.

## Data model (initial)

- `Lead` — id, name, email, phone, source, raw payload, score, tier, status (`new | contacted | engaged | qualified | disqualified | converted | unresponsive`), crmId, consent flags, timestamps
- `LeadEvent` — leadId, type (`captured | scored | message_sent | message_failed | reply_received | crm_synced | …`), channel, payload, createdAt
- `Sequence` / `SequenceStep` — tier, step order, delay, channel, template id
- `Enrollment` — leadId, sequenceId, current step, status (`active | stopped | completed`), next run time
- `Template` — channel, name, body with variables (`{{firstName}}`, …)

---

## Avoid in version 1:
- Microservices.
- Multi-tenancy.
- Complex authentication.
- Event sourcing.
- Full DDD architecture.
- Separate frontend/backend monorepo.
- Advanced observability.
- Multiple AI providers from the beginning.
- Overengeneering

## Implementation steps

### Phase 0 — Project setup ✅ (done 2026-09-22)

1. Initialize the TypeScript project (`package.json`, `tsconfig`, ESLint, Prettier, Vitest).
2. Add `docker-compose.yml` with Postgres and Redis. Add `.env.example` covering every provider credential.
3. Set up Prisma with the initial schema and first migration.
4. Build the Fastify app skeleton: `/health`, structured logging (pino), config loading validated with Zod.
5. Add a CI workflow that runs lint, typecheck and tests.

**Done when:** `docker compose up` plus the dev server starts, `/health` returns 200, and CI is green.

### Phase 1 — Automatic capture ✅ (done 2026-09-23)

1. `POST /webhooks/forms/:provider` endpoint with a signature/secret check for each provider.
2. `FormAdapter` interface: `verify(req)` and `normalize(payload) → LeadInput`.
3. Implement the first adapters: a generic website form and one provider (e.g. Typeform).
4. Normalize data: trim/lowercase email, convert phone to E.164, split names, record source/UTM.
5. Deduplicate: match on email/phone and merge into the existing lead instead of creating a duplicate.
6. Save the `Lead` plus a `captured` event, reply 200 quickly, and enqueue `lead.captured`.

**Done when:** a sample webhook creates exactly one lead (even when replayed), and a job is enqueued.

Implementation notes:

- Providers: `website` (shared secret in `X-Webhook-Secret`) and `typeform` (HMAC in `Typeform-Signature`). A provider is enabled only when its secret env var is set; otherwise its URL returns 404.
- Idempotency: the `captured` event stores `dedupeKey = <source>:<externalId>` (unique). Typeform uses the response token. The website form uses `submissionId`, or a hash of the payload when that's missing. A replay returns 200 with `duplicate: true` and writes nothing.
- Merge policy: match on email or phone (oldest lead wins) and fill blanks only. First-touch UTM wins, answers (`Lead.fields`) are merged with the newest winning, and consent stays once given. Each submission's raw payload is kept on its `captured` event. Advisory locks on email/phone serialize concurrent captures of the same person.
- Queue: the job id is the `captured` event id. If enqueueing fails after the commit, the webhook returns 500, and the provider's retry hits the dedupe path, which enqueues the job again.

### Phase 2 — Qualification ✅ (done 2026-09-23, LLM pass not done)

1. Rule-based scoring engine that reads JSON rules (e.g. budget field, company size, source, valid phone, business email vs. free email).
2. Map score to tier: hot / warm / cold / disqualified (thresholds come from config).
3. Hard disqualifiers: invalid contact data, spam patterns, blocked domains, missing consent.
4. Save the score and tier with a `scored` event, then enqueue `lead.qualified`.
5. _(Optional, later)_ an LLM-assisted pass to classify free-text answers such as intent or urgency.

**Done when:** unit tests cover each rule, and fixture leads land in the expected tiers.

Implementation notes:

- The rules live in `config/scoring.json` (path set by `SCORING_RULES_PATH`) and are validated with Zod when the worker starts. Conditions are `{ fact, op, value }` with `eq | in | gt | gte | lt | lte | exists | matches`, combined with `all` / `any` / `not`. Facts are the lead's columns (`fields.<name>` and `utm.<key>` reach inside the JSON) plus the derived `emailDomain`, `emailType` (business / free / none) and `text` (for spam patterns). Rule points add up. `tiers.hot` / `tiers.warm` are the minimum scores, and any matching disqualifier gives the `disqualified` tier.
- The worker (`src/worker.ts`, a separate process) consumes `lead.captured`. Scoring is idempotent per capture (`dedupeKey = scored:<captured event id>`), and each new submission from a merged lead is scored again. Status moves only between `new`, `qualified` and `disqualified`. A lead that has moved past those (contacted, engaged, opted out, …) keeps its status, but its score and tier still update.
- `lead.qualified` is enqueued only for hot/warm/cold leads (job id = scored event id).
- **For Phase 3:** a re-submission enqueues `lead.qualified` again. The contact worker must therefore only act on leads whose status is still `qualified`, and must check consent per channel.

### Phase 3 — Immediate contact ✅ (done 2026-09-23, dry-run verified; real providers untested)

1. `MessagingAdapter` (WhatsApp/SMS) and `EmailAdapter` interfaces: `send(to, template, vars) → externalId`.
2. Implement the first providers (e.g. WhatsApp Cloud API + Resend). Include a **dry-run/console adapter** for development.
3. Template rendering with variables. Use approved WhatsApp templates for the first contact.
4. Channel strategy by tier: hot → WhatsApp + email right away and alert the sales rep; warm → email + WhatsApp; cold → email only.
5. Respect consent, opt-outs and quiet hours (lead's timezone).
6. Retry with backoff when a send fails, and record `message_sent` or `message_failed`.

**Done when:** a qualified lead gets its first message within about 1 minute (dry-run in dev, real sandbox in staging).

Implementation notes:

- Providers: WhatsApp Cloud API (`MESSAGING_PROVIDER=whatsapp`), Resend (`EMAIL_PROVIDER=resend`) and `dry-run` (the default, which logs the rendered message). They are called with plain `fetch`, with no SDKs. Twilio/SMS and SendGrid are not implemented; SMS has no provider, so the planner skips it.
- Templates live in the `Template` table (`npm run db:seed` creates the defaults) and use `{{var}}` / `{{var|fallback}}`. A variable with no value and no fallback fails the message permanently. WhatsApp always sends the approved template by `name` + `locale`, and the variables in `body` fill its parameters in order.
- The channel strategy and quiet hours live in `config/contact.json` (`CONTACT_CONFIG_PATH`). The worker refuses to start if a template it references is missing from the database.
- Flow: `lead.qualified` → the planner picks messages by the lead's **current** tier, status (`qualified`/`contacted`), consent and address, then enqueues one `message.send` job per message. Quiet hours apply to WhatsApp/SMS as a job delay, in the lead's time zone (or the default one). Email goes out right away. `SALES_ALERT_EMAIL` gets an email alert for hot leads (`rep_notified` event).
- Idempotency: each channel gets at most one first contact per lead (`first-contact:<lead>:<channel>`), and each lead at most one rep alert (`rep-alert:<lead>`). A re-qualification to a higher tier only adds the channels not contacted yet. The send job re-checks eligibility when it runs, since the lead may have opted out during quiet hours.
- Retries: 6 attempts with exponential backoff (5s…80s). 429/5xx/network errors are retried. Other 4xx errors, a missing template and missing variables are permanent (BullMQ `UnrecoverableError`). `message_failed` is recorded once, when the failure is permanent or on the last attempt. The first successful lead message moves `qualified` → `contacted`.
- Known gap: if the process dies after the provider accepted a message but before the event is written, the retry sends it again. Resend dedupes this with the `Idempotency-Key`; WhatsApp has no equivalent.

### Phase 4 — Scheduled follow-up ✅ (done 2026-09-23; re-engagement sequence not done)

1. Sequence definitions per tier (e.g. hot: +1h, +1d, +3d; warm: +1d, +3d, +7d; cold: +3d, +7d, +14d).
2. Enroll the lead after first contact. Each step is a BullMQ delayed job, and `Enrollment.nextRunAt` is saved so the schedule survives a restart.
3. Inbound reply webhooks (WhatsApp, email) → match to the lead → **stop the sequence**, set status `engaged`, notify the rep.
4. Handle opt-outs ("STOP", unsubscribe link) → stop everything and mark `do_not_contact`.
5. When the sequence ends with no reply → status `unresponsive`, with an optional long-term re-engagement sequence.

**Done when:** a lead that never replies gets all steps on time, and a lead that replies gets nothing further.

Implementation notes:

- Sequences live in the database (`npm run db:seed` creates `hot_follow_up`, `warm_follow_up` and `cold_follow_up` with the plan's timings). `config/contact.json` names each tier's sequence (`followUpSequence`). `SequenceStep.offsetMinutes` counts from enrollment. `Sequence.finalWaitMinutes` is how long to wait after the last step before marking the lead `unresponsive`.
- Enrollment happens in the same transaction as the first successful first contact (the `qualified` → `contacted` transition), so a lead is enrolled once. Each step is a `followup.step` delayed job (id = enrollment + step + due time). It queues the step's message through `message.send` (quiet hours apply, and consent/status are re-checked at send time) and schedules the next step. After downtime, the planned gap between steps is kept instead of sending overdue steps back to back.
- `Enrollment.nextRunAt` is the source of truth. The worker re-enqueues due-soon steps at startup and every 10 minutes, so lost Redis jobs are rebuilt (verified by wiping Redis).
- Replies: `POST /webhooks/replies/whatsapp` (Meta signature `X-Hub-Signature-256` using `WHATSAPP_APP_SECRET`; `GET` answers the verify-token handshake) and `POST /webhooks/replies/email` (generic JSON `{from, subject?, text?, messageId?}` + `X-Webhook-Secret`, for whichever inbound-mail service relays it). A reply is matched to the oldest lead with that phone/email. It records `reply_received`, stops sequences, sets `engaged` and alerts the rep once (`rep_alert_reply`). Idempotent per provider message id.
- Opt-outs: a reply whose first line or subject is exactly a keyword from `contact.json` (`STOP`, `SAIR`, …, ignoring case, accents and punctuation), or the unsubscribe link, sets `do_not_contact`, records `opted_out` and stops sequences. Queued messages are dropped at send time. Links are `/unsubscribe?lead=…&token=<HMAC>` (`PUBLIC_BASE_URL` + `UNSUBSCRIBE_SECRET`, template var `{{unsubscribeUrl}}`). GET shows a confirmation button and POST unsubscribes, which also serves RFC 8058 one-click. Resend emails get `List-Unsubscribe` headers. Rep alerts never get the link.
- Not done / known limits: the optional long-term re-engagement sequence. A lead re-qualified to a higher tier stays in its original sequence. An `unresponsive` lead that submits a form again is re-scored but not contacted again. WhatsApp delivery statuses are ignored. Email replies need a relay into the generic format (no provider-specific inbound adapter yet).

### Phase 5 — CRM update ✅ (done 2026-09-23, dry-run verified; HubSpot API untested against a real portal)

1. `CrmAdapter` interface: `upsertContact`, `updateStage`, `logActivity`, `assignOwner`.
2. Implement the first CRM (HubSpot or Pipedrive). Map LeadFlow status to CRM pipeline stages.
3. A CRM sync worker reads `lead_events`, pushes each one as an activity/note, and updates the stage.
4. Handle rate limits, retries, and a dead-letter queue for failed syncs.
5. _(Optional)_ a CRM → LeadFlow webhook so that when a rep changes the stage (e.g. "won"), the sequence stops.

**Done when:** every lead shows up in the CRM with the right stage and a complete activity timeline.

Implementation notes:

- CRM: HubSpot (`CRM_PROVIDER=hubspot`, private app token) plus `dry-run`. `CrmAdapter` has `upsertContact` (by stored id, then email; phone-only leads are created), `updateStage` (contact properties), `logActivity` (a note associated with the contact) and `assignOwner` (`hubspot_owner_id`, per tier, on creation).
- `config/crm.json`: `stages` maps every LeadFlow status to CRM properties (`hs_lead_status`, `lifecyclestage`); `owners` per tier; `syncDisqualified`; `inbound` rules for CRM → LeadFlow. HubSpot won't move `lifecyclestage` backwards, so the default mapping only moves it forward.
- The sync is pull-based: every 30s the worker finds leads with events past their cursor (`Lead.crmSyncedThrough` / `crmSyncedEventId`, since events are append-only) and queues one `crm.sync` job per lead (concurrency 1). The job upserts the contact, sets the stage from the current status, and pushes each new event as a note, advancing the cursor after each one. Events younger than 10s are held back, because `createdAt` is the transaction's start time and a slow transaction could otherwise commit behind the cursor.
- Resilience: requests are throttled to 90 per 10s. A 429 pauses the queue (`worker.rateLimit`) without using up an attempt. 5xx/network errors are retried with exponential backoff (8 attempts, about 4 hours). Other 4xx errors, or the last attempt, dead-letter the lead: `crmSyncFailedAt`/`crmSyncError` are set, a `crm_sync_failed` event is recorded, and an entry goes to the `crm.sync.dead` queue. The sweep skips the lead until `npm run crm:requeue [leadId…]`. A contact deleted in HubSpot (404) is recreated.
- CRM → LeadFlow (done): `POST /webhooks/crm/hubspot` (v3 signature using `HUBSPOT_CLIENT_SECRET` over `PUBLIC_BASE_URL` + path, requests older than 5 min rejected). `contact.propertyChange` events matching an `inbound` rule set the lead's status (default `lifecyclestage=customer` → `converted`), record `status_changed` and stop the follow-up.
- Known limits: a note can be duplicated if the process dies between HubSpot accepting it and the cursor update (at-least-once). A phone-only contact can be duplicated the same way on creation. The throttle is per worker process. Events that share a transaction have the same timestamp, so their order in the CRM is arbitrary.

### Phase 6 — Operations and visibility ✅ (done 2026-09-23)

1. Admin endpoints (or a small dashboard): list and filter leads, view one lead's timeline, pause/resume an enrollment, requeue failed jobs.
2. Metrics: time-to-first-contact, reply rate per sequence step, conversion by source/tier, failed sends.
3. Alerts for queue backlog, provider errors and failed CRM syncs.
4. Queue UI (Bull Board) protected by auth.

### Phase 7 — Hardening and launch

1. Security: verify webhook signatures, keep secrets in the environment/secret manager, rate-limit public endpoints.
2. Compliance: store consent (LGPD/GDPR), respect opt-outs across channels, data retention and deletion endpoint.
3. End-to-end tests: from form webhook through to the CRM, using sandbox/dry-run adapters.
4. Deploy (API + workers as separate processes, managed Postgres/Redis) and a staging environment wired to provider sandboxes.
5. Pilot with one form source and one CRM pipeline, then add more providers.

---

## Open decisions

- ~~Which CRM goes first (HubSpot vs. Pipedrive vs. other)?~~ HubSpot (Phase 5).
- Which messaging provider (WhatsApp Cloud API directly vs. Twilio)? _Phase 3 implemented WhatsApp Cloud API + Resend behind adapters; confirm before going live._
- Which form sources matter at launch?
- Is a UI needed in v1, or are CRM + admin endpoints enough?
- Hosting target (e.g. Fly.io, Railway, AWS, GCP)?
