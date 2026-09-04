# SMS Notification Service

A standalone NestJS SMS notification microservice. It exposes a private-network HTTP endpoint
for accepting SMS messages, persists them durably in PostgreSQL, and delivers them
asynchronously through a reliable queue pipeline with provider failover (Twilio, Bird),
bounded retries, a dead-letter queue, and Twilio signature-verified delivery webhooks. Bird
signature verification remains provisional pending its official callback contract.

## Architecture

The delivery path is built around a transactional outbox so a provider is never called before
the message is durably committed:

```text
POST /api/v1/sms/send
      │  (validate + encrypt body, one transaction)
      ▼
PostgreSQL  ── sms_messages + outbox_events + idempotency key
      │
      ▼  OutboxRelayService (polls unpublished initial, retry, DLQ, and requeue events)
BullMQ  ── sms-dispatch queue (Redis)
      │
      ▼  SmsProcessor (worker: claim -> dispatch -> retry rounds)
ProviderManager  ── ordered pass: Twilio -> Bird (failover on retryable errors)
      │  success -> SENT              exhausted/permanent -> FATAL_FAILURE
      ▼                                          │
provider accepts                                 ▼
      │                                    sms-dlq queue
      ▼                              POST /internal/dlq/:id/requeue
Delivery webhook (signed)
POST /webhooks/twilio | /webhooks/bird  ── SENT -> DELIVERED | UNDELIVERED | REJECTED
```

Key properties:

- **Idempotent ingestion.** `X-Idempotency-Key` is valid for 24 hours; a repeat returns the
  original record and never re-sends.
- **Transactional outbox.** The message row, its outbox event, and the idempotency key are
  written in one transaction; the relay bridges to BullMQ, decoupled from Redis availability.
- **Failover + bounded retries.** A single ordered provider pass advances through every remaining
  configured provider after any failure, stopping only on success. If no provider succeeds, a
  permanent failure prevents another retry round and dead-letters the message; a new round is
  scheduled only when every attempt failed transiently. The worker retries the configured chain
  for up to `PROVIDER_MAX_RETRY_ROUNDS` rounds with exponential backoff.
- **Timeouts are ambiguous.** A provider timeout is recorded as an ambiguous attempt because the
  provider might have accepted the SMS before the response was lost. Failover or retry can replay
  that message and may result in recipient-visible duplicate delivery.
- **Webhook verification.** Twilio delivery reports advance the lifecycle only after signature
  validation, idempotently. Bird verification uses a provisional assumed HMAC-SHA256 contract;
  validate it against Bird's official signing, header, and payload contract before treating it as
  verified.
- **Privacy-safe.** The SMS body is encrypted at rest; phone numbers and bodies are redacted from
  structured logger fields. Error-message content requires operational review before treating logs
  as comprehensively content-safe.

## Prerequisites

- Node.js 22 or later
- Docker Compose (local PostgreSQL 17 and Redis 7)

## Local setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the environment template and fill it in:
   ```bash
   cp .env.example .env
   ```
   Replace every provider placeholder, and generate `ENCRYPTION_KEY`:
   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```
   Credentials are required only for providers listed in `SMS_PROVIDER_PRIORITY`. See
   [`docs/configuration.md`](docs/configuration.md) for every variable.
3. Start PostgreSQL and Redis:
   ```bash
   docker compose up -d
   ```
4. Apply database migrations:
   ```bash
   npm run prisma:migrate        # local development (prisma migrate dev)
   # in a non-interactive / production context: npx prisma migrate deploy
   ```
5. Generate the Prisma client:
   ```bash
   npm run prisma:generate
   ```
6. Run the service:
   ```bash
   npm run start:dev             # watch mode
   # or, for a compiled run:
   npm run build && npm start
   ```

The health endpoint is `GET http://localhost:3000/health` and returns `{ "status": "ok" }`.

## npm scripts

| Script                     | Description                                                   |
| -------------------------- | ------------------------------------------------------------- |
| `npm run build`            | Compile TypeScript to `dist/` (`tsc -p tsconfig.build.json`). |
| `npm start`                | Run the compiled service (`node dist/main`).                  |
| `npm run start:dev`        | Run in watch mode from source (`node --watch` + `ts-node`).   |
| `npm run lint`             | Lint `src/` and `test/` with ESLint.                          |
| `npm run lint:fix`         | Lint and auto-fix.                                            |
| `npm run format`           | Prettier-format source and select config/doc files.           |
| `npm run format:check`     | Verify formatting without writing.                            |
| `npm run typecheck`        | Type-check with no emit (`tsc --noEmit`).                     |
| `npm test`                 | Run the unit test suite (`jest --runInBand`).                 |
| `npm run test:integration` | Run integration tests against Docker Compose Postgres/Redis.  |
| `npm run test:watch`       | Run tests in watch mode.                                      |
| `npm run prisma:generate`  | Generate the Prisma client.                                   |
| `npm run prisma:validate`  | Validate the Prisma schema.                                   |
| `npm run prisma:format`    | Format the Prisma schema.                                     |
| `npm run prisma:migrate`   | Apply migrations in local dev (`prisma migrate dev`).         |

## Verification

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run prisma:validate
```

`npm run test:integration` has live PostgreSQL/Redis test files and requires the Docker Compose
dependencies and migrations to be running. It is not a replacement for the unit suite, and it does
not currently cover every planned end-to-end acceptance scenario.

## Documentation

- [`docs/api.md`](docs/api.md) — HTTP API: the send endpoint contract, webhooks, and DLQ
  requeue, with request/response examples and status codes.
- [`docs/states.md`](docs/states.md) — the message state machine and every allowed transition.
- [`docs/configuration.md`](docs/configuration.md) — every environment variable, defaults, and
  the provider-credential rule.
- [`docs/dlq-runbook.md`](docs/dlq-runbook.md) — operational runbook for dead-lettered messages
  and requeue.
- [`docs/provider-sandbox.md`](docs/provider-sandbox.md) — manual sandbox verification with
  real provider credentials and a public callback tunnel.
- [`docs/acceptance-traceability.md`](docs/acceptance-traceability.md) — PRD acceptance and
  Definition-of-Done evidence, present Docker-dependent integration coverage, known gaps, and
  external verification blockers.

## Scope

This service implements the first release only: `POST /api/v1/sms/send`, idempotent ingestion,
the transactional outbox, BullMQ dispatch with provider failover and retries, DLQ and requeue,
and authenticated Twilio/Bird delivery webhooks. Internal dispatch and DLQ routes are
private-network only (`PRIVATE_NETWORK_CIDRS`); public exposure is limited to provider
webhooks. Bird's signature scheme is an assumption pending real Bird documentation and
credentials — see [`docs/provider-sandbox.md`](docs/provider-sandbox.md).
