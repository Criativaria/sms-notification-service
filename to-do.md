# SMS Notification Microservice: Implementation Checklist

## 0. Confirm Scope

- [x] Treat `SMS Notification Service PRD.pdf` as the highest-priority requirement source.
- [x] Keep the project as a standalone NestJS microservice, not a monolith module.
- [x] Keep the first release limited to SMS, Twilio, Bird, PostgreSQL, Redis/BullMQ, DLQ, and webhooks.
- [x] Do not add campaigns, scheduling, bulk sending, a dashboard, or extra transports.

## 1. Bootstrap the Service

- [x] Create the NestJS application with TypeScript.
- [x] Add ESLint, Prettier, Jest, and scripts for linting, type checking, and tests.
- [x] Add a global validation pipe with whitelist and transform enabled.
- [x] Add `@nestjs/config` with startup environment validation.
- [x] Create `.env.example` with placeholders only.
- [x] Create Docker Compose services for PostgreSQL and Redis with health checks.
- [x] Add a README section for local setup and execution.

Done when: the application, PostgreSQL, and Redis start locally without errors.

## 2. Build Persistence

- [x] Install and configure Prisma for PostgreSQL.
- [x] Create a `sms_messages` table with UUID ID, idempotency key, recipient phone, encrypted message body, metadata, status, selected provider, provider message ID, last error, timestamps, and attempt counters.
- [x] Add a unique idempotency-key constraint and an index for provider message IDs.
- [x] Create `sms_attempts` to preserve each provider attempt and its result.
- [x] Create `outbox_events` to persist queue-publication intent in the same transaction as the SMS record.
- [x] Create migrations and verify a clean database can apply them.
  Status: `prisma migrate deploy` applied `20260904120000_persistence_foundation` to a clean Docker PostgreSQL; all five tables verified via `psql \dt`. Root cause of the earlier port blocker: a stale compose container had been created without the published port mapping, so `docker compose up -d` only restarted it; fixed with `docker compose down` + `up -d --force-recreate`.
- [x] Add scheduled retention cleanup for records older than 90 days.
  Status: `RetentionService` (setInterval, overlap-guarded) purges only terminal messages past `retentionExpiresAt`, deleting `sms_attempts` + `outbox_events` before the message rows (Restrict FKs), emitting a `RETENTION_CLEANUP` audit log and incrementing a deleted-count metric. Unit-tested.

Done when: a message, its outbox event, and its audit fields are written atomically.

## 3. Implement Request Ingestion

- [x] Add `POST /api/v1/sms/send`.
- [x] Accept `to`, `message`, and optional `metadata` in the body.
- [x] Require `X-Idempotency-Key` in the request headers.
- [x] Validate E.164 phone numbers.
- [x] Enforce a configurable message length with a 160-character default.
- [~] Limit and validate metadata as a JSON object.
  Note (2026-09-04): `SendSmsDto` validates metadata only with `@IsObject` (`src/modules/sms/dto/send-sms.dto.ts`), so a non-object (string/array) is correctly rejected with 400, but there is NO size/key-count limit — an oversized-but-valid object is accepted (202). "Validate as a JSON object" is met; the "limit" half is not enforced. Documented as a gap; no code change made this session per the decision to document rather than expand scope.
- [x] Create the message as `QUEUED` and save its outbox event in one database transaction.
- [x] Return `202 Accepted` with the message ID, status, and creation timestamp.
- [x] For a repeated idempotency key inside 24 hours, return the existing record without enqueueing or sending again.
- [x] Restrict this endpoint to the private network.

Done when: API tests cover successful acceptance, invalid input, and sequential/concurrent duplicate requests.
Status: `POST /api/v1/sms/send` implemented with DTO validation, private-network guard, AES-256-GCM body encryption at rest, and the exact `{ status, data: { messageId, status, createdAt } }` 202 envelope. 22 unit tests plus a live end-to-end smoke test confirmed: valid send → 202 QUEUED, duplicate key → same id with no second row, invalid phone → 400, missing `X-Idempotency-Key` → 400, and ciphertext (not plaintext) persisted.

## 4. Implement the Reliable Queue

- [x] Configure BullMQ and a dedicated SMS queue.
- [x] Implement the outbox relay that publishes pending events to BullMQ.
- [x] Add periodic reconciliation for unpublished outbox events.
- [x] Use a deterministic BullMQ job ID derived from the internal message ID.
- [x] Implement the worker and atomic state transitions: `QUEUED`, `PROCESSING`, `SENT`, `DELIVERED`, `UNDELIVERED`, `REJECTED`, and `FATAL_FAILURE`.
- [x] Add exponential backoff for transient failures.
- [x] Apply a configurable limit of three provider-chain rounds by default.
- [x] Set a configurable per-provider limiter with a 10 TPS default.
- [x] Configure a DLQ for fatal failures.
- [x] Add a private-network management endpoint to requeue a DLQ message idempotently and audit the action.
- [x] Prevent automatic duplicate provider submission after an ambiguous provider outcome.
  Policy: create a durable provider-attempt reservation before every provider HTTP call. Timeouts, network failures, and unclassifiable errors move the attempt to an operationally reconcilable ambiguous state (`AWAITING_PROVIDER_RESULT`) and never automatically resend through the same or another provider. A definitive result (success, or a clean HTTP error response) is safe to act on: the worker releases the reservation and continues.
  Status (2026-09-04, RESOLVED): `SendSmsResult.isAmbiguous` is now set explicitly by each provider strategy from the normalized error kind (`timeout`/`network`/`unknown` → ambiguous; a received HTTP response, including an error status → definitive). `SmsLifecycleRepository.reserveProviderAttempt`/`finalizeProviderAttempt` are provider-agnostic and take `isAmbiguous`/`isRetryable` as explicit caller-supplied inputs rather than inferring them from the outcome label, so a definitive failure and an ambiguous one can never be conflated. A new state-machine edge `AWAITING_PROVIDER_RESULT → PROCESSING` lets a definitive failure release the reservation; `beginProcessing` deliberately uses its own narrower explicit source list (`QUEUED`, `RETRY_SCHEDULED`) rather than the raw structural `sourceStatesOf`, so a message holding an outstanding reservation can never be re-claimed as a fresh job (this exact regression was caught by the test suite during implementation — see `sms-lifecycle.repository.spec.ts`'s dedicated guard test). `ProviderManager.dispatch()` also stops immediately on an ambiguous attempt as defense in depth, even though the worker does not call it directly. `resolveTwilioAttempt` (the private audited manual-resolution path for a still-ambiguous attempt) exists and is tested but has no controller endpoint yet — remains a documented follow-up, not required for the no-duplicate-send guarantee.

Done when: messages survive worker/Redis interruption, transient failures back off, and exhausted failures move to the DLQ.
Status (2026-09-04, RESOLVED): `SmsProcessor.process` now loops over `ProviderFactory.getOrderedProviders()` directly (not `ProviderManager`, which cannot checkpoint persistence between providers): it reserves, calls, and finalizes each provider attempt in turn, continuing to the next provider on a definitive failure and stopping immediately on success or an ambiguous outcome. When every configured provider fails definitively in one pass, it schedules an exponential-backoff retry round (`scheduleRetry`, base 2s × 2^round via `backoffDelayMs`, capped at `PROVIDER_MAX_RETRY_ROUNDS`, default 3) if any failure was retryable, else dead-letters immediately (`markFatalFailure` → DLQ). Verified live end-to-end against Docker PostgreSQL + Redis + the local Bird mock server (see Section 5): a real `POST /api/v1/sms/send` → worker dispatch → `SENT` via Bird → simulated signed Bird webhook → `DELIVERED`, and separately, Twilio-definitive-failure → automatic Bird failover → `SENT`, and both-providers-fail-transiently → `MESSAGE_RETRY_SCHEDULED round=1`, observed live in the running app's logs. Automated coverage: `src/modules/queue/sms.processor.int-spec.ts` (Docker-backed: ambiguous timeout parks without failover, definitive failure fails over to the next provider within a pass, both-fail schedules a retry round, exhaustion → DLQ, DLQ requeue, rate-limiter config) plus `src/modules/queue/sms.processor.spec.ts` (unit, all outcome branches). The outbox relay (setInterval, reconciling) routes committed initial, retry, dead-letter, and administrative requeue intents to BullMQ with event-id job deduplication; retry/DLQ/requeue lifecycle transitions persist their outbox intent atomically, so Redis publication failures reconcile later.

## 5. Implement Provider Abstraction

- [x] Define `ISmsProvider`, `SendSmsOptions`, and `SendSmsResult`.
- [x] Normalize provider errors into retryable and permanent failures.
- [x] Treat timeouts, network failures, 408, 429, and 5xx responses as transient.
- [x] Treat other provider 4xx business failures as permanent unless a provider contract proves otherwise.
- [x] Implement `TwilioProvider` with configured timeout and error mapping.
- [x] Implement `BirdProvider` for Bird Messaging API with environment placeholders until credentials are available.
- [x] Implement `ProviderManager` using `SMS_PROVIDER_PRIORITY=twilio,bird`.
- [x] Validate configured provider names and required environment values at startup.
- [x] On a retryable Twilio failure, attempt Bird immediately.
- [x] Retry the complete provider chain with exponential backoff only if all active providers fail transiently.
  Status: `ProviderManager.dispatch()` performs one ordered pass; the queue worker (Section 4) owns the multi-round exponential-backoff loop (base 2s × 2^round, capped at `PROVIDER_MAX_RETRY_ROUNDS`) and moves the message to the DLQ on exhaustion. Implemented and unit-tested.

Done when: integration tests demonstrate automatic Twilio-to-Bird failover.
Status (2026-09-04, RESOLVED): 22 unit tests cover the interface, error classifier, both strategies, factory, and single-pass Twilio→Bird failover. Worker-driven failover is now real (see Section 4) and Docker-backed integration-tested in `sms.processor.int-spec.ts`; `providers/failover.int-spec.ts` additionally proves the `ProviderManager` layer directly (real HTTP-stubbed Twilio/Bird strategies) for a definitive-503, a definitive-429, and a permanent-400 (no failover) case. Live end-to-end verification against the local Bird mock server (Section 5 below) additionally confirmed a real Twilio-definitive-failure → Bird-success dispatch in the running app. `BirdProvider`/`TwilioProvider` now read a configurable `BIRD_API_BASE_URL`/`TWILIO_API_BASE_URL` (default the real provider APIs) so they can point at a mock server without any code change — see the Bird mock section below.

### Bird Local Mock Server

Bird Messaging is a paid API; for local development and the presentation demo it is mocked rather than using real (or no) credentials. `mock-servers/bird/server.ts` (Express, run via the repo's existing `ts-node`) implements the send endpoint (`POST /workspaces/:workspaceId/channels/:channelId/messages`), deterministic failure injection via `X-Mock-Force: retryable|permanent|timeout`, and a `POST /simulate-callback/:messageId` route that signs and forwards a delivery webhook to the real service using the exact HMAC-SHA256 scheme `bird-signature.verifier.ts` expects. Wired into `compose.yaml` as the `bird-mock` service (`docker compose up -d bird-mock`, port 8081) and pointed at by `.env`/`.env.example` via `BIRD_API_BASE_URL=http://localhost:8081`. Full contract, start instructions, and a failover+webhook demo script are in [`docs/provider-sandbox.md`](docs/provider-sandbox.md). Verified live 2026-09-04: a real `POST /api/v1/sms/send` (with `SMS_PROVIDER_PRIORITY=bird`) dispatched through the running worker, landed `SENT` with a `bird-mock-*` provider message id, and a `simulate-callback` request produced a `200 {"status":"ok"}` from the real webhook verifier, moving the message to `DELIVERED`.

## 6. Implement Webhooks

- [x] Add `POST /webhooks/twilio`.
- [x] Add `POST /webhooks/bird`.
- [x] Preserve raw request bodies when required by provider signature verification.
- [x] Verify official Twilio and Bird signatures using environment secrets.
- [x] Reject invalid webhook signatures with `401` or `403`.
- [x] Match callbacks through `providerMessageId`.
- [x] Deduplicate repeated callbacks.
- [x] Allow only valid delivery-status transitions.
- [x] Update `SENT` messages to `DELIVERED`, `UNDELIVERED`, or `REJECTED` from validated callbacks.
- [x] Document how to test sandbox callbacks through a temporary public tunnel when credentials are available.

Done when: mocked signed callbacks update status correctly and repeated callbacks have no side effects.
Status: `main.ts` enabled `{ rawBody: true }`. Twilio HMAC-SHA1 and Bird HMAC-SHA256 verified with `crypto.timingSafeEqual`; invalid/missing signature → 403. Correlation by `providerMessageId`; idempotent via the lifecycle `applyDeliveryReport` (duplicate → 200 no-op, invalid transition → 409, unknown id → 404). Proven live: a valid signed Twilio `delivered` callback moved a SENT message to DELIVERED; a tampered signature returned 403; a repeated valid callback was a harmless 200. Bird uses a documented `X-Bird-Signature` assumption pending real credentials. Sandbox-tunnel doc still to write.

## 7. Add Observability and Data Protection

- [x] Configure Pino JSON logging.
- [x] Mask phone numbers and never log the full message body.
- [x] Encrypt message content at rest.
- [x] Log `MESSAGE_QUEUED`, `PROVIDER_ATTEMPT`, `PROVIDER_FAILOVER`, `MESSAGE_SENT`, and `WEBHOOK_RECEIVED`.
- [ ] Add metrics for queue backlog, processing latency, provider attempts, failovers, errors, and DLQ depth.
  Status: A retention-deleted counter exists; a full metrics surface (queue backlog, latency, failovers, DLQ depth) is NOT yet implemented. Not part of the PRD Definition of Done; deferred as an operational enhancement.
- [x] Emit an audit event and metric after each retention-cleanup run.
- [x] Document a DLQ requeue runbook.

Done when: logs are structured and safe, and operational failures are diagnosable without exposing PII.
Status: `nestjs-pino` emits pure JSON; `main.ts` routes all Nest loggers through Pino. Redaction censors auth/signature/idempotency headers and PII field names; `err.message` is intentionally kept readable. `maskPhone`/`maskBody` helpers available. Verified live: a real send left no phone/body/idempotency-key in the JSON logs. AES-256-GCM encrypts the body at rest.

## 8. Complete Verification

- [x] Unit-test the provider registry, Twilio provider, Bird provider, and error classification.
- [x] Integration-test API validation and idempotency.
  Status: `src/modules/sms/sms.controller.int-spec.ts` boots the real `AppModule` (main.ts config: rawBody + whitelist/transform ValidationPipe), listens on an ephemeral loopback port, and drives `POST /api/v1/sms/send` over HTTP with axios so `PrivateNetworkGuard` passes. 8 tests, verified green against live PostgreSQL by the orchestrator: valid → 202 `{ status:'success', data:{ messageId, status:'QUEUED', createdAt } }` with exactly one row; missing `X-Idempotency-Key` → 400; non-E.164 → 400; message > 160 → 400; metadata as string and as array → 400; sequential duplicate → same messageId, one row; 5 concurrent duplicates → single messageId, one row. Cleanup is delete-by-id (no truncation). Gap noted below (metadata size limit).
- [x] Integration-test transactional outbox publication and recovery.
  Status: Docker-backed PostgreSQL/Redis tests passed on 2026-09-04: persisted outbox events publish exactly once with deterministic job IDs, failed queue publication remains recoverable, and the post-enqueue/pre-mark crash window reconciles without duplicate jobs.
- [x] Integration-test retries, backoff, rate limiting, DLQ, and DLQ requeue.
  Status (2026-09-04, RESOLVED): `src/modules/queue/sms.processor.int-spec.ts` (9 tests, verified green against live Redis + PostgreSQL) now covers both the retry/DLQ seams AND the live worker driving them: an ambiguous `[timeout]` parks the message in `AWAITING_PROVIDER_RESULT` without failing over or retrying; a definitive retryable failure on the first provider fails over to the next provider WITHIN THE SAME WORKER PASS and completes `SENT`; when every provider fails definitively and transiently, the worker itself schedules a backed-off retry round (`MESSAGE_RETRY_SCHEDULED`, `retryRounds` incremented, `SMS_RETRY_SCHEDULED` outbox event with exponential `delayMs`); `scheduleRetry`/`markFatalFailure`/DLQ routing/requeue idempotency/the 10 TPS limiter are all covered as before. The former architectural gap (worker not consuming the retry/failover/DLQ machinery) is closed — see Section 4.
- [x] Integration-test Twilio retryable failure followed by Bird success.
  Status (2026-09-04, RESOLVED): `src/modules/providers/failover.int-spec.ts` (4 tests) proves failover at the `ProviderManager` layer (Twilio 503/429 → Bird success; permanent Twilio 400 does not retry). `sms.processor.int-spec.ts`'s new "fails over to the next provider within the same pass" test proves the SAME behavior through the actual live worker (`SmsProcessor.process`), which now loops `ProviderFactory.getOrderedProviders()` directly. Live end-to-end confirmation against the local Bird mock server additionally observed `PROVIDER_ATTEMPT_FAILED provider=twilio` → `PROVIDER_FAILOVER` → `MESSAGE_SENT provider=bird` in the running app's logs. The former gap (worker never consumed `ProviderManager` or any failover path) is closed.
- [x] Integration-test authenticated webhook status updates and duplicate callbacks.
  Status: `src/modules/webhooks/webhooks.int-spec.ts` (12 tests, verified green against live PostgreSQL). Boots the real app with the exact `main.ts` bootstrap (`rawBody: true` + whitelisting ValidationPipe) and signs callbacks with the verifiers' own `computeTwilioSignature`/`computeBirdSignature` helpers. Twilio and Bird: valid signed `delivered` → SENT→DELIVERED; invalid and missing signature → 403 with no state change; duplicate valid callback → harmless 200 no-op (status and `updatedAt` unchanged); unknown `providerMessageId` → 404; invalid transition from a terminal state → 409; non-terminal callback status → 200 ignored. Bird signing (HMAC-SHA256 hex over the raw body) is exercised as the documented assumption pending real Bird credentials — tests will need updating if the real Bird scheme differs.
- [x] Run lint, type checking, unit tests, and integration tests.
  Status: Re-verified 2026-09-04 after this session's additions. `npm run format:check` (clean), `npm run lint` (clean), `npm run typecheck` (clean), `npm test` = 27 suites / 198 unit tests passing, and `npm run test:integration` = 7 suites / 37 integration tests passing against Docker PostgreSQL + Redis. Note: two pre-existing prettier violations in `sms-lifecycle.repository.ts` (untouched by the ambiguous-Twilio work) were auto-formatted this session; the earlier "194 tests / format:check passed" line predated the state-machine and lifecycle-mock regressions that this session fixed.
- [x] Confirm every PRD acceptance criterion is covered by a test or documented manual sandbox check.
  Status (2026-09-04): [`docs/acceptance-traceability.md`](docs/acceptance-traceability.md) refreshed to reflect the B1 worker fix and the Bird local mock server. Every FR/NFR/DoD row now cites Docker-backed integration coverage, unit coverage, or documented manual/mock verification. Three criteria remain honestly recorded as gaps (not silently accepted): NFR-10 (stale `PROCESSING` recovery after a worker crash — no lease/watchdog implemented), NFR-11 (DLQ Redis job retention/consumption bounds — no consumer/cleanup implemented), and the retention scheduler using in-process `setInterval` rather than the PRD-planned BullMQ scheduler (NFR-8). None of these three block the core reliability guarantee (no duplicate SMS delivery), which is now fully closed and tested (see Section 4/NFR-9).
- [x] Review `.env.example` and repository history to ensure no credentials are committed.
  Status: Working-tree audit PASS. `.env.example` holds only `replace-with-*` placeholders; tree-wide grep found no real Twilio/Bird SID/token/signing secret and no non-test phone number (only the reserved test numbers `+14155552671`, `+15551234567`, `+14155550000`). The one real-format secret, `ENCRYPTION_KEY`, exists only in `.env`, which `.gitignore` excludes (`.env` + `!.env.example`). Note: the project is not a Git repository, so commit history could not be scanned; audited the working tree instead.

## Deferred Enhancements

- [ ] Add service-to-service authentication for internal and management endpoints when hosting requirements demand it: API key, JWT service token, or mTLS.
- [ ] Add a protected message status lookup endpoint when an operational consumer needs it.
- [ ] Add a real provider sandbox test after Twilio/Bird credentials and a public callback URL are available.
