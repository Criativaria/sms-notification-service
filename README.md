# SMS Notification Service

A standalone NestJS microservice that accepts SMS send requests over a private-network HTTP
endpoint, persists them durably in PostgreSQL, and delivers them asynchronously through a
reliable queue pipeline with automatic provider failover (Twilio, Bird), bounded retries, a
database-authoritative dead-letter queue, and signed delivery webhooks. The design is built
around a transactional outbox so a provider is never called before a message is durably
committed, and it treats provider timeouts as ambiguous outcomes rather than silently retrying
into a duplicate send.

Key properties:

- **Idempotent ingestion** — a repeated `X-Idempotency-Key` returns the original record and
  never re-sends.
- **Transactional outbox** — the message row, its outbox event, and the idempotency key are
  written in one transaction, decoupling durability from Redis availability.
- **Automatic provider failover** — an ordered pass across the configured providers (Twilio,
  Bird, or both) advances on any retryable failure and stops on success.
- **Dead-letter queue with requeue** — exhausted or permanently failed messages land in
  `FATAL_FAILURE`, recorded in PostgreSQL, and can be replayed via a private-network endpoint.
- **Ambiguous-outcome handling** — a provider timeout is never automatically retried or failed
  over, since the provider may have already accepted the message; it parks in
  `AWAITING_PROVIDER_RESULT` until a webhook resolves it or a delayed expiry finalizes it.

## Architecture

```text
POST /api/v1/sms/send
      │  (validate + encrypt body, one transaction)
      ▼
PostgreSQL  ── sms_messages + outbox_events + idempotency key
      │
       ▼  OutboxRelayService (polls unpublished initial-dispatch, retry, DLQ, and requeue events)
BullMQ  ── sms-dispatch queue (Redis)
      │
      ▼  SmsProcessor (worker: claim -> dispatch -> retry rounds)
ProviderManager  ── ordered pass: Twilio -> Bird (failover on retryable errors)
      │  success -> SENT              exhausted/permanent -> FATAL_FAILURE
      ▼                                          │
provider accepts                                 ▼
       │                                    sms-dlq notification worker (ephemeral)
      ▼                              POST /internal/dlq/:id/requeue
Delivery webhook (signed)
POST /webhooks/twilio | /webhooks/bird  ── SENT -> DELIVERED | UNDELIVERED | REJECTED
```

See [`docs/states.md`](docs/states.md) for the complete state machine and every allowed
transition.

## Requirements

- Node.js 22 or later
- Docker (with Compose) — local PostgreSQL 17, Redis 7, and the Bird mock server
- npm

## Quick start

```bash
git clone <this-repo>
cd desafio-sms-fresh-start
npm install
cp .env.example .env
```

Generate `ENCRYPTION_KEY` and paste it into `.env`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

`.env.example` ships with `SMS_PROVIDER_PRIORITY=twilio,bird` and placeholder Twilio/Bird
credentials. You only need to fill in credentials for the provider(s) actually listed in
`SMS_PROVIDER_PRIORITY` — see [Configuration](#configuration) below. For a zero-credential local
run, set `SMS_PROVIDER_PRIORITY=bird` and uncomment `BIRD_API_BASE_URL=http://localhost:8081` to
point at the bundled Bird mock instead of the real API (any non-empty `BIRD_API_KEY` placeholder
still satisfies startup validation).

Start PostgreSQL, Redis, and the Bird mock:

```bash
docker compose up -d
```

Apply migrations (this is a fresh clone, so `prisma migrate dev` is correct here — it creates
and applies the initial migration; use `npx prisma migrate deploy` instead in a non-interactive
or production context):

```bash
npm run prisma:migrate
npm run prisma:generate
```

Run the service:

```bash
npm run start:dev
```

Confirm it's up:

```bash
curl http://localhost:3000/health
# { "status": "ok" }
```

## Configuration

Every variable is validated at startup by `src/config/environment.validation.ts` (Joi,
`abortEarly: false`) — a misconfigured `.env` reports every problem at once and refuses to
start. Full reference: [`docs/configuration.md`](docs/configuration.md). Grouped highlights:

**Provider selection**

- `SMS_PROVIDER_PRIORITY` — comma-separated, e.g. `twilio`, `bird`, or `twilio,bird`. Sets both
  the failover order and which credentials are required — an unlisted provider's credentials are
  not validated and its provider class is never constructed.
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` — required only if `twilio`
  is listed.
- `BIRD_API_KEY` / `BIRD_WORKSPACE_ID` / `BIRD_CHANNEL_ID` / `BIRD_WEBHOOK_SIGNING_KEY` —
  required only if `bird` is listed.
- `BIRD_API_BASE_URL` / `TWILIO_API_BASE_URL` — override the provider's base URL; used to point
  `BirdProvider` at the local mock (`http://localhost:8081`) instead of the real API.

**Database and queue**

- `DATABASE_URL` — PostgreSQL connection string.
- `REDIS_URL` — Redis connection string, backs BullMQ.

**Security and network**

- `SERVICE_URL` — public base URL, used to reconstruct the Twilio callback URL for signature
  verification.
- `PRIVATE_NETWORK_CIDRS` — comma-separated CIDRs allowed to call `/api/v1/sms/send` and
  `/internal/dlq/*`. The default `127.0.0.1/32,::1/128` means these routes work out of the box
  against `localhost`/loopback without any extra setup.
- `ENCRYPTION_KEY` — base64-encoded 32-byte key used to encrypt the SMS body at rest.

**Tuning and limits**

- `MAX_MESSAGE_LENGTH` (default `160`), `IDEMPOTENCY_TTL_HOURS` (default `24`).
- `PROVIDER_MAX_RETRY_ROUNDS` (default `3`) — full ordered-provider rounds before dead-lettering.
- `SMS_PROVIDER_TPS` (default `10`), with optional `SMS_PROVIDER_TPS_TWILIO` /
  `SMS_PROVIDER_TPS_BIRD` overrides.
- `PROCESSING_RECOVERY_INTERVAL_MS`, `PROCESSING_STALE_AFTER_MS`,
  `PROCESSING_RECOVERY_BATCH_SIZE` — stale `PROCESSING` row recovery.
- `AMBIGUOUS_OUTCOME_EXPIRY_MS` (default 15 minutes) — delay before an unresolved ambiguous
  provider outcome finalizes as `UNDELIVERED`.

## API overview

No global path prefix; base URL in local development is `http://localhost:3000`.

| Method | Path                               | Auth / guard               | Purpose                                          |
| ------ | ---------------------------------- | -------------------------- | ------------------------------------------------ |
| `GET`  | `/health`                          | None                       | Liveness probe                                   |
| `POST` | `/api/v1/sms/send`                 | `PrivateNetworkGuard`      | Accept an SMS for asynchronous delivery          |
| `POST` | `/webhooks/twilio`                 | Twilio HMAC-SHA1 signature | Twilio delivery-status callback                  |
| `POST` | `/webhooks/bird`                   | Bird HMAC-SHA256 signature | Bird delivery-status callback                    |
| `POST` | `/internal/dlq/:messageId/requeue` | `PrivateNetworkGuard`      | Replay a dead-lettered (`FATAL_FAILURE`) message |

`PrivateNetworkGuard` matches the socket remote address (never `X-Forwarded-For`) against
`PRIVATE_NETWORK_CIDRS`; a caller outside those CIDRs gets `403 Forbidden`.

Full request/response schemas, status codes, and error shapes are in
[`docs/api.md`](docs/api.md). An `openapi.yaml` file at the repo root is importable directly
into Insomnia or Postman for interactive exploration.

### Testing with Insomnia

Import `openapi.yaml` (repo root) into Insomnia — or Postman, or any OpenAPI 3 importer — to get
every real endpoint pre-configured with example request bodies. The private-network-only routes
(`/api/v1/sms/send`, `/internal/dlq/:messageId/requeue`) work against `localhost` right after
import, since the default `PRIVATE_NETWORK_CIDRS` already allows loopback.
The two webhook routes (`/webhooks/twilio`, `/webhooks/bird`) will 403 on a bare import-and-send,
because they require a real HMAC signature; use the Bird mock's `POST /simulate-callback/:messageId`
flow from [`docs/provider-sandbox.md`](docs/provider-sandbox.md) instead to trigger a genuinely
signed webhook call.

## Testing

### Unit tests

No infrastructure required:

```bash
npm test
```

### Integration tests

Require live PostgreSQL and Redis, because these tests exercise real transactions, real BullMQ
publication, and real signed HTTP round trips rather than mocks:

```bash
docker compose up -d
npm run prisma:migrate
npm run test:integration
```

### Manual end-to-end walkthrough

With `docker compose up -d` and `npm run start:dev` both running (defaults: `SMS_PROVIDER_PRIORITY=bird`
pointed at the bundled mock, or real Twilio/Bird credentials if you've set them):

1. **Send a message.**

   > On a real Twilio trial account, `to` must be a
   > [verified Caller ID](https://console.twilio.com/us1/develop/phone-numbers/manage/verified)
   > you've added to the account (otherwise Twilio returns error
   > [572002](https://www.twilio.com/docs/errors/572002) — replace `+15551234567` below with your
   > own verified number), and `message` must match one of the approved sample-message categories
   > registered for the sending number — arbitrary free text is rejected while the number's use
   > case is pending verification. `sms_appointment_reminders` is the category approved for this
   > project's number.

   ```bash
   curl -X POST http://localhost:3000/api/v1/sms/send \
     -H "Content-Type: application/json" \
     -H "X-Idempotency-Key: teste-016" \
     -d '{
       "to": "+15551234567",
       "message": "sms_appointment_reminders",
       "metadata": { "origem": "manual" }
     }'
   ```

   Expected `202 Accepted`:

   ```json
   {
     "status": "success",
     "data": {
       "messageId": "8c161082-a14e-44c3-8584-a8c5d71d383a",
       "status": "QUEUED",
       "createdAt": "2026-09-05T02:27:29.004Z"
     }
   }
   ```

2. **Watch it move `QUEUED -> PROCESSING -> SENT`.** There is no `GET` status endpoint — check
   via the database or the structured logs:

   ```sql
   SELECT id, status, "selectedProvider", "providerMessageId", "updatedAt"
   FROM sms_messages WHERE "idempotencyKey" = 'demo-001';
   ```

3. **Simulate a delivery webhook** using the Bird mock server (`bird-mock`, port 8081). Take the
   `provider_message_id` from the query above (a `bird-mock-<uuid>` value when Bird was
   selected) and trigger a signed callback:

   ```bash
   curl -X POST http://localhost:8081/simulate-callback/<provider_message_id> \
     -H "Content-Type: application/json" \
     -d '{"status":"delivered"}'
   ```

   Re-run the query above and confirm the message is now `DELIVERED`. See
   [`docs/provider-sandbox.md`](docs/provider-sandbox.md) for the full mock contract and a
   Twilio real-sandbox walkthrough via a public tunnel.

4. **Exercise failover / retry / DLQ.** The Bird mock accepts an `X-Mock-Force` request header
   on its send endpoint (`retryable` -> `503`, `permanent` -> `400`, `timeout` -> the request
   hangs until the provider's own HTTP timeout fires) so these paths can be forced on demand.
   The running service does not forward this header from `POST /api/v1/sms/send`, so drive the
   mock directly to confirm each response shape, or point `TWILIO_API_BASE_URL` /
   `BIRD_API_BASE_URL` at a failing target to force a real failover during dispatch. Once a
   message reaches `FATAL_FAILURE` (all providers/rounds exhausted), requeue it:

   ```bash
   curl -X POST http://localhost:3000/internal/dlq/<messageId>/requeue
   ```

   A successful requeue returns `202 { "messageId": "...", "status": "requeued" }` and resets
   the message to `RETRY_SCHEDULED` with a full retry budget. See
   [`docs/dlq-runbook.md`](docs/dlq-runbook.md) for inspection queries and the full requeue
   contract.

### Quality gate

```bash
npm run lint
npm run typecheck
npm run format:check
```

## Project structure

```text
src/
  modules/
    sms/          # Ingestion: DTO validation, private-network guard, idempotency
    providers/    # Twilio/Bird provider strategies, error classification, failover ordering
    queue/         # BullMQ dispatch worker, outbox relay, rate limiting, DLQ processor
    webhooks/      # Signed Twilio/Bird delivery-status callbacks
    maintenance/   # Retention purge, stale-processing recovery, ambiguous-outcome expiry
  database/        # Prisma repositories and the SMS lifecycle state machine
  observability/    # Structured logging config
  config/          # Startup environment validation
mock-servers/bird/  # Local mock of Bird's Messages API for demo/dev use
```

## Known limitations / out of scope

- **Bird is deliberately mocked.** Bird is a paid API with no free sandbox; the challenge
  author confirmed that mocking it from its public documentation is an accepted, sufficient
  approach for this project, not a workaround. The local mock server
  (`mock-servers/bird/server.ts`, `docker compose up -d bird-mock`) exercises the full send +
  signed-delivery-webhook round trip end to end. Bird's signature scheme
  (`X-Bird-Signature`, HMAC-SHA256) is therefore an assumption built from Bird's public docs,
  not independently verified against a live account.
- No protected message-status lookup endpoint exists yet; check status via the database or
  logs (see [Testing](#testing) above).
- No service-to-service authentication (API key / JWT / mTLS) on internal endpoints; they rely
  solely on `PRIVATE_NETWORK_CIDRS`.
- A genuine Redis outage/restart and a hard worker-process crash mid-job are not covered by
  automated integration tests (only a simulated publish rejection is).

See `to-do.md`'s "Deferred Enhancements" section for the full list of intentionally deferred
work, and [`docs/acceptance-traceability.md`](docs/acceptance-traceability.md) for the complete
PRD-to-evidence mapping, including what's resolved versus genuinely open.

## Documentation

- [`docs/api.md`](docs/api.md) — full HTTP API reference.
- [`docs/states.md`](docs/states.md) — the message state machine.
- [`docs/configuration.md`](docs/configuration.md) — every environment variable.
- [`docs/dlq-runbook.md`](docs/dlq-runbook.md) — DLQ operations.
- [`docs/provider-sandbox.md`](docs/provider-sandbox.md) — manual provider verification and the
  Bird mock contract.
- [`docs/acceptance-traceability.md`](docs/acceptance-traceability.md) — PRD acceptance evidence.
