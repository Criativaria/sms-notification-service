# Execution Plan: SMS Notification Microservice

## Goal

Build the standalone NestJS SMS Notification Microservice specified in the PRD. It must accept internal SMS dispatch requests, reliably persist and queue them, send through Twilio or Bird with retry and automatic failover, process authenticated delivery callbacks, and prevent duplicate deliveries.

The PRD is the source of truth. Earlier monolith assumptions are superseded because the PRD explicitly requires a standalone microservice.

## First-Release Scope

- `POST /api/v1/sms/send` internal dispatch endpoint.
- PostgreSQL audit trail and transactional persistence.
- Redis and BullMQ for asynchronous processing, exponential retries, provider throttling, and a dead-letter queue (DLQ).
- Extensible provider abstraction with Twilio and Bird Messaging API implementations.
- 24-hour idempotency through `X-Idempotency-Key`.
- Authenticated Twilio and Bird delivery webhooks.
- Protected management endpoint for DLQ requeue.
- Unit and integration tests plus local Docker Compose dependencies.

Out of scope: campaigns, scheduling, bulk sends, a management UI, additional notification channels, and gRPC/AMQP/Kafka ingestion.

## Proposed Technical Decisions

| Area | Decision |
| --- | --- |
| Runtime | NestJS and TypeScript |
| Database | PostgreSQL with Prisma and versioned migrations |
| Queue | BullMQ backed by Redis |
| Delivery guarantee | PostgreSQL transactional outbox plus a relay/reconciliation worker |
| Idempotency | Unique database constraint as the final guard; Redis cache/lock only for low-latency checks |
| Duplicate key behavior | Return the existing record for any request reusing the key within 24 hours, without re-sending |
| Providers | `ISmsProvider` implementations registered through NestJS dependency injection; no provider conditionals in orchestration |
| Provider priority | `SMS_PROVIDER_PRIORITY=twilio,bird`, validated at startup and configurable per environment |
| Failover and retries | Immediately attempt Bird after a retryable Twilio failure; retry the ordered provider chain for up to three rounds with exponential backoff only if every active provider fails transiently |
| Provider limits | Start at 10 TPS per provider, configurable by environment |
| Message length | Configurable, with a 160-character default |
| Observability | Pino structured JSON logs, with phone numbers and message bodies masked |
| Sensitive data | Encrypt message body at rest; retain records for 90 days and purge automatically |
| Internal endpoint access | Private network only; deferred improvement: add service-to-service authentication when deployment requirements demand it |
| Configuration | Validated `@nestjs/config` environment schema and `.env.example` with no secrets |
| Tests | Jest unit/integration tests with PostgreSQL and Redis through Docker Compose; mocked provider and webhook tests plus documented sandbox verification |
| Retention cleanup | BullMQ scheduled job with an audit event and metric |

The transactional outbox is required to meet the PRD's no-message-loss objective. A database insert followed by a separate queue publish can fail between those operations. The outbox records the publication intent in the same database transaction as the message, then a relay safely publishes and reconciles pending events.

## State Model

`QUEUED -> PROCESSING -> SENT -> DELIVERED`

Failure paths: `PROCESSING -> RETRY_SCHEDULED`, `PROCESSING -> UNDELIVERED`, `PROCESSING -> REJECTED`, or `PROCESSING -> FATAL_FAILURE`.

`SENT` means the provider accepted the message. `DELIVERED`, `UNDELIVERED`, and `REJECTED` are set only by validated provider webhooks. Store every provider attempt in `sms_attempts` to preserve history across retries and failovers.

## Implementation Phases

### 1. Repository Foundation

- Scaffold the NestJS service with module boundaries, linting, formatting, tests, and quality scripts.
- Add Docker Compose for PostgreSQL and Redis, including health checks.
- Implement typed, startup-validated configuration and document local setup in `.env.example` and the README.

Validation: the application starts without errors or warnings; Docker dependencies become healthy; baseline tests pass.

### 2. Persistence and Ingestion Contract

- Create `sms_messages`, `sms_attempts`, and `outbox_events` schemas with migrations.
- Implement the formal PRD API contract: `POST /api/v1/sms/send` with `to`, `message`, optional `metadata`, and required `X-Idempotency-Key`.
- Validate E.164 numbers, a configurable message maximum of 160 characters by default, metadata limits, and `X-Idempotency-Key`.
- Return an existing tracking record without re-sending when the idempotency key already exists within 24 hours.
- Persist a `QUEUED` message and its outbox event in one database transaction.

Validation: API tests cover invalid input, normal creation, sequential duplicates, and concurrent duplicates.

### 3. Reliable Queue Processing

- Build the outbox relay and pending-event reconciliation routine.
- Build the BullMQ worker, atomic state transitions, per-message locking, and attempt accounting.
- Configure exponential backoff, configurable attempt limits, and rate limiting per provider.
- Configure the DLQ, persist fatal causes, and implement a protected, audited idempotent requeue endpoint. A status lookup endpoint is a future enhancement, not part of this challenge scope.

Validation: accepted messages survive worker or Redis downtime; simulated timeout, 429, and 5xx failures show backoff and DLQ behavior.

### 4. Provider Abstraction and Failover

- Define `ISmsProvider` with normalized results, external message IDs, and retryability classification.
- Implement Twilio and Bird Messaging API providers with timeouts, error mapping, and independent configuration. Use environment placeholders until Bird credentials are available.
- Implement `ProviderManager` to read `SMS_PROVIDER_PRIORITY` and provider limits from configuration, validating every configured provider at startup.
- Use mocked providers before external credentials are available.

Validation: unit-test each provider and integration-test automatic Bird dispatch after a retryable Twilio failure.

### 5. Webhooks and Operational Security

- Expose `POST /webhooks/twilio` and `POST /webhooks/bird`.
- Preserve raw request bodies where signature verification requires them.
- Validate official provider signatures and replay protections where supported.
- Correlate callbacks by `providerMessageId`, deduplicate callbacks, and permit only valid state transitions.
- Limit internal and management endpoints to the private network. Keep service-to-service authentication as a documented future enhancement, not a requirement for this challenge.

Validation: valid signed callbacks update delivery status; invalid signatures receive `401` or `403`; duplicate callbacks are harmless.

### 6. Observability, Documentation, and Acceptance

- Emit `MESSAGE_QUEUED`, `PROVIDER_ATTEMPT`, `PROVIDER_FAILOVER`, `MESSAGE_SENT`, and `WEBHOOK_RECEIVED` structured events.
- Add metrics for queue backlog, latency, attempts, failovers, provider errors, and DLQ volume.
- Document the API, states, configuration, local setup, retention policy, DLQ runbook, and a provider sandbox verification procedure.
- Run unit tests, integration tests, linting, and type checking. Run provider sandbox verification when credentials become available.

Validation: all PRD acceptance criteria pass, with manual webhook sandbox verification recorded.

## Suggested Delivery Order

1. Phases 1 and 2: safely accept and persist requests.
2. Phase 3: reliable delivery pipeline and DLQ using a fake provider.
3. Phase 4: Twilio, Bird, retry, and failover.
4. Phase 5: authenticated delivery confirmation.
5. Phase 6: operational readiness and final acceptance.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Database-to-queue gap causes message loss | Transactional outbox, unique idempotency index, and deterministic BullMQ job ID |
| Provider timeout causes an ambiguous send result | Use provider idempotency where available; record the attempt and surface the ambiguous state |
| Redis outage | Accept only after PostgreSQL commit; the outbox relay recovers queue publication |
| Forged or repeated webhooks | Official signature verification, raw-body handling, deduplication, and state-transition guards |
| PII leakage | Field encryption, centralized masking, and no full message body in logs |
| Provider throttling | Per-provider BullMQ rate limiters and environment configuration |

## Open Questions

1. Bird Messaging API credentials and webhook signing secrets are unavailable. The service will use explicit environment placeholders and mocked automated tests until they are supplied.
2. A real Twilio/Bird sandbox callback test requires a temporary public tunnel or staging URL. It is documented as a manual verification step and is not required for the local automated suite.
3. Internal and management endpoints will be private-network-only for this challenge. Future implementation idea: add service-to-service authentication with an API key, JWT service token, or mTLS when the hosting environment requires it.
4. Future enhancement: add a protected `GET /api/v1/sms/:messageId` status lookup endpoint when an operational consumer requires it.
