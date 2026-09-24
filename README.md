# LeadFlow

Lead follow-up automation. LeadFlow captures leads from forms, scores them, contacts them right away over WhatsApp and email, follows up on a schedule until they reply, and keeps the CRM (HubSpot) up to date.

```
form webhook → capture → qualification → first contact → follow-up sequence → CRM sync
                                            (reply / opt-out stops it)
```

## Running locally

Requires Node 20+ and Docker.

```bash
npm install
cp .env.example .env          # defaults use dry-run providers: nothing is really sent
docker compose up -d --wait   # Postgres + Redis
npm run db:deploy             # apply migrations
npm run db:seed               # default templates and follow-up sequences
npm run dev                   # API on :3000
npm run dev:worker            # background worker (separate terminal)
```

Tests: `npm test` (unit), `npm run test:db` (Postgres/Redis, including an end-to-end run from form to CRM).

## Documentation

- [`docs/deploy.md`](docs/deploy.md): deploying (Docker image, release step, staging), privacy operations (LGPD/GDPR access, erasure, retention) and the pilot checklist.
- [`.env.example`](.env.example): every setting.
- `config/*.json`: scoring rules, contact strategy and quiet hours, CRM stage mapping.
