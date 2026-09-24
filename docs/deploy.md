# Deploying LeadFlow

LeadFlow ships as one Docker image that runs three ways. It works on any platform that runs containers (Fly.io, Railway, Render, ECS, Cloud Run with a separate always-on worker, Kubernetes…). The image isn't tied to any one platform.

| Process     | Command                                                                 | Scale                                    | Notes                                                                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Release** | image target `release` (runs `prisma migrate deploy && prisma db seed`) | once per deploy, before the others start | Idempotent. Applies migrations and creates missing default templates/sequences. It never overwrites edited ones.                                                                                                                                                                        |
| **API**     | `node dist/server.js` (default command)                                 | 1+ behind a load balancer                | Liveness `GET /health`, readiness `GET /health/ready` (checks Postgres and Redis). Listens on `PORT` (3000).                                                                                                                                                                            |
| **Worker**  | `node dist/worker.js`                                                   | 1+                                       | Consumes every queue and runs the periodic tasks (follow-up reconcile, CRM sweep, alerts, retention). All of them are safe to run on several workers. There's no HTTP port: supervise the process, and rely on the queue-backlog alert (`is the worker running?`) to notice a dead one. |

```bash
docker build --target runtime -t leadflow .          # API + worker
docker build --target release -t leadflow-release .  # release step
```

Both processes stop gracefully on `SIGTERM`: in-flight requests and jobs finish first.

## Managed services

- **PostgreSQL** 14 or newer. Turn on automated backups with point-in-time recovery. The database is the source of truth: leads, the event log, follow-up schedules, consent records and the suppression list all live there.
- **Redis** 6.2 or newer, for BullMQ queues, rate-limit counters and alert state. It needs two settings:
  - `maxmemory-policy noeviction`. BullMQ breaks if Redis evicts its keys, so use a dedicated instance or database.
  - Persistence (AOF). Follow-up steps and CRM syncs rebuild themselves from Postgres after Redis data loss, but leads captured and not yet scored or contacted at that moment would sit idle until their next event. See [Known limitations](#known-limitations).

## Configuration

Every setting is an environment variable, documented in [`.env.example`](../.env.example) and validated at startup by `src/config.ts`. A bad value stops the process with a readable error. Keep secrets in the platform's secret store, never in the image or the repo.

Required everywhere: `DATABASE_URL`, `REDIS_URL`.

Security-relevant:

- `TRUST_PROXY`: **set it when running behind a load balancer.** Otherwise every request appears to come from the balancer's IP and they all share one rate-limit bucket. Use a hop count (usually `1`) or the balancer's CIDRs. Avoid `true` unless every hop in front of the app is yours.
- `RATE_LIMIT_PER_MINUTE`: per client IP on every route but health checks, shared across API instances through Redis (300 by default). If Redis is unreachable, requests are let through rather than rejected. Raise it if one sender posts in bulk, such as your website backend's IP.
- `ADMIN_TOKEN` (at least 24 characters; `openssl rand -hex 24`). This enables `/admin/api` and the queue UI at `/admin/queues`. Leave it unset to turn the admin surface off entirely. To rotate it, change the secret and redeploy.
- Webhook secrets: `FORM_WEBHOOK_SECRET`, `TYPEFORM_WEBHOOK_SECRET`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `REPLY_WEBHOOK_SECRET`, `HUBSPOT_CLIENT_SECRET`. Each provider's webhook is only served when its secret is set, and every inbound request is signature- or secret-checked.
- `UNSUBSCRIBE_SECRET` signs unsubscribe links. Rotating it invalidates links in emails already sent, so rotate only if it leaked. Recipients can still reply STOP.

Webhook URLs to register with each provider (`PUBLIC_BASE_URL` + path):

| Provider                  | URL                                                        |
| ------------------------- | ---------------------------------------------------------- |
| Website form backend      | `POST /webhooks/forms/website` (header `x-webhook-secret`) |
| Typeform                  | `POST /webhooks/forms/typeform`                            |
| WhatsApp Cloud API (Meta) | `GET`/`POST /webhooks/replies/whatsapp`                    |
| Inbound email relay       | `POST /webhooks/replies/email` (header `x-webhook-secret`) |
| HubSpot app               | `POST /webhooks/crm/hubspot`                               |

## Staging

Run a full copy with its own Postgres, Redis and secrets, wired to provider sandboxes:

- **Messaging**: start with `MESSAGING_PROVIDER=dry-run` and `EMAIL_PROVIDER=dry-run`, which log instead of sending. Then switch to real sandboxes:
  - WhatsApp: the Cloud API test phone number Meta provides, which only delivers to the recipient numbers you register.
  - Email: Resend with a staging sending domain, or its test recipient addresses.
- **CRM**: `CRM_PROVIDER=dry-run` first, then a HubSpot developer test account with its own private-app token and client secret. **Never point staging at the production CRM**, because the privacy erase endpoint can permanently delete contacts.
- **Forms**: a copy of the production form, pointed at the staging URL.
- **Data**: synthetic leads only. Staging must not hold real people's data.

Before promoting a release, run a lead through staging and confirm each step. Use `GET /admin/api/leads/:id` to see the timeline:

1. captured, then scored
2. first contact sent
3. enrolled
4. reply received, then sequence stopped
5. synced to the CRM

## Privacy operations (LGPD / GDPR)

- **Consent evidence**: every grant and withdrawal is stored in `ConsentRecord`, with what the person saw. Typeform sends its consent questions' text. The website backend should send `consent: { text, version, at, ip, userAgent, pageUrl }`. Opt-outs (STOP reply, unsubscribe link) withdraw consent on every channel.
- **Access request**: `POST /admin/api/privacy/export` with `{"email": "…"}` and/or `{"phone": "…"}` returns every lead, event, enrollment and consent record for that person.
- **Erasure request**: `POST /admin/api/privacy/erase` with `{"email": "…", "deleteFromCrm": true, "confirm": true}`. It deletes the person's leads and everything attached. With `deleteFromCrm`, it also permanently deletes their HubSpot contacts (GDPR delete). The addresses go on the suppression list, stored only as SHA-256 hashes, so a later form submission is captured as `do_not_contact` and never messaged. The `Erasure` table logs the request without personal data.
- **Retention**: set `DATA_RETENTION_DAYS` (at least 30, e.g. 730). The worker then erases leads with no activity for that long and no follow-up in progress, hourly. Addresses that had opted out stay suppressed. Automatic deletion stays off until this is set.
- Messaging providers and the CRM keep their own copies of messages and contacts. An erasure with `deleteFromCrm` covers HubSpot. Provider message logs follow the provider's own retention.

```bash
curl -X POST "$BASE/admin/api/privacy/erase" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"email": "person@example.com", "deleteFromCrm": true, "confirm": true}'
```

## Pilot checklist

Launch with **one form source and one CRM pipeline**, watch it for a week or two, then add providers.

- [ ] Production Postgres (backups + PITR) and Redis (`noeviction`, AOF) provisioned.
- [ ] All secrets in the secret store; `TRUST_PROXY` set; `ADMIN_TOKEN` set.
- [ ] Release step runs before each deploy; API has health and readiness probes; worker is supervised.
- [ ] Only one form provider's secret is set, so only that webhook is live.
- [ ] Templates reviewed (`npm run db:seed` defaults are placeholders). WhatsApp templates approved in Meta with matching names and locales.
- [ ] `config/scoring.json`, `config/contact.json` (quiet hours, tier strategy) and `config/crm.json` (stage mapping, owners) reviewed with sales.
- [ ] `SALES_ALERT_EMAIL` and `ALERT_WEBHOOK_URL` point at people who will act on them.
- [ ] Unsubscribe links on (`PUBLIC_BASE_URL` + `UNSUBSCRIBE_SECRET`) and present in every email template.
- [ ] Privacy notice on the form links to how people can ask for access or erasure. Consent text sent as evidence.
- [ ] `DATA_RETENTION_DAYS` decided and set.
- [ ] One end-to-end test lead in production (your own address), then erased with `privacy/erase`.
- [ ] During the pilot, check `GET /admin/api/metrics` (time to first contact, reply rate per step, conversion) and the alerts channel daily.

## Rollback

Roll back by redeploying the previous image. Migrations only move forward, so a rollback runs the old code against the new schema. Additive migrations, which is all of them so far, are safe for that. A migration that removes or renames something must be split over two releases: first stop using it, then drop it.

## Known limitations

- **Redis data loss** strands leads captured but not yet scored or contacted at that moment. Their jobs are gone, and only follow-ups and CRM syncs are rebuilt from Postgres. Find them with `GET /admin/api/leads?status=new` or `?status=qualified`, since a lead waiting longer than a few minutes is stuck. Requeueing them still has to be done by hand.
- **Queued follow-up messages** that are waiting out quiet hours are dropped if their enrollment is paused. They are not delayed.
