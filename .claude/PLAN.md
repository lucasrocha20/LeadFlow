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

## Implementation steps

### Phase 0 — Project setup ✅ (done 2026-09-22)

1. Initialize the TypeScript project (`package.json`, `tsconfig`, ESLint, Prettier, Vitest).
2. Add `docker-compose.yml` with Postgres and Redis. Add `.env.example` covering every provider credential.
3. Set up Prisma with the initial schema and first migration.
4. Build the Fastify app skeleton: `/health`, structured logging (pino), config loading validated with Zod.
5. Add a CI workflow that runs lint, typecheck and tests.

**Done when:** `docker compose up` plus the dev server starts, `/health` returns 200, and CI is green.

### Phase 1 — Automatic capture

1. `POST /webhooks/forms/:provider` endpoint with a signature/secret check for each provider.
2. `FormAdapter` interface: `verify(req)` and `normalize(payload) → LeadInput`.
3. Implement the first adapters: a generic website form and one provider (e.g. Typeform).
4. Normalize data: trim/lowercase email, convert phone to E.164, split names, record source/UTM.
5. Deduplicate: match on email/phone and merge into the existing lead instead of creating a duplicate.
6. Save the `Lead` plus a `captured` event, reply 200 quickly, and enqueue `lead.captured`.

**Done when:** a sample webhook creates exactly one lead (even when replayed), and a job is enqueued.

### Phase 2 — Qualification

1. Rule-based scoring engine that reads JSON rules (e.g. budget field, company size, source, valid phone, business email vs. free email).
2. Map score to tier: hot / warm / cold / disqualified (thresholds come from config).
3. Hard disqualifiers: invalid contact data, spam patterns, blocked domains, missing consent.
4. Save the score and tier with a `scored` event, then enqueue `lead.qualified`.
5. _(Optional, later)_ an LLM-assisted pass to classify free-text answers such as intent or urgency.

**Done when:** unit tests cover each rule, and fixture leads land in the expected tiers.

### Phase 3 — Immediate contact

1. `MessagingAdapter` (WhatsApp/SMS) and `EmailAdapter` interfaces: `send(to, template, vars) → externalId`.
2. Implement the first providers (e.g. WhatsApp Cloud API + Resend). Include a **dry-run/console adapter** for development.
3. Template rendering with variables. Use approved WhatsApp templates for the first contact.
4. Channel strategy by tier: hot → WhatsApp + email right away and alert the sales rep; warm → email + WhatsApp; cold → email only.
5. Respect consent, opt-outs and quiet hours (lead's timezone).
6. Retry with backoff when a send fails, and record `message_sent` or `message_failed`.

**Done when:** a qualified lead gets its first message within about 1 minute (dry-run in dev, real sandbox in staging).

### Phase 4 — Scheduled follow-up

1. Sequence definitions per tier (e.g. hot: +1h, +1d, +3d; warm: +1d, +3d, +7d; cold: +3d, +7d, +14d).
2. Enroll the lead after first contact. Each step is a BullMQ delayed job, and `Enrollment.nextRunAt` is saved so the schedule survives a restart.
3. Inbound reply webhooks (WhatsApp, email) → match to the lead → **stop the sequence**, set status `engaged`, notify the rep.
4. Handle opt-outs ("STOP", unsubscribe link) → stop everything and mark `do_not_contact`.
5. When the sequence ends with no reply → status `unresponsive`, with an optional long-term re-engagement sequence.

**Done when:** a lead that never replies gets all steps on time, and a lead that replies gets nothing further.

### Phase 5 — CRM update

1. `CrmAdapter` interface: `upsertContact`, `updateStage`, `logActivity`, `assignOwner`.
2. Implement the first CRM (HubSpot or Pipedrive). Map LeadFlow status to CRM pipeline stages.
3. A CRM sync worker reads `lead_events`, pushes each one as an activity/note, and updates the stage.
4. Handle rate limits, retries, and a dead-letter queue for failed syncs.
5. _(Optional)_ a CRM → LeadFlow webhook so that when a rep changes the stage (e.g. "won"), the sequence stops.

**Done when:** every lead shows up in the CRM with the right stage and a complete activity timeline.

### Phase 6 — Operations and visibility

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

- Which CRM goes first (HubSpot vs. Pipedrive vs. other)?
- Which messaging provider (WhatsApp Cloud API directly vs. Twilio)?
- Which form sources matter at launch?
- Is a UI needed in v1, or are CRM + admin endpoints enough?
- Hosting target (e.g. Fly.io, Railway, AWS, GCP)?
