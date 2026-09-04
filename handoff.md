# Orchestrator Handoff: SMS Notification Microservice

## Mission and Sources of Truth

Build the standalone NestJS SMS Notification Microservice described in `SMS Notification Service PRD.pdf`.

Read sources in this order:

1. `SMS Notification Service PRD.pdf`
2. `AGENTS.md`
3. `PLAN.md`
4. `to-do.md`

The project is not a Git repository. Do not assume branches, commits, or worktrees are available.

## Orchestration Requirement

The user requested an orchestration model. Delegate implementation, investigation, testing, and review work to sub-agents. The lead agent should coordinate dependencies, inspect their reports, commission independent reviews at module boundaries, and ensure work conforms to the sources of truth.

Keep `to-do.md` current in real time. Mark an item complete only after its implementation and relevant validation pass. Record partial progress and blockers accurately; never mark unverified integration work complete.

## Current State

Completed and reflected in `to-do.md`:

- NestJS and TypeScript foundation, ESLint, Prettier, Jest, build/typecheck/test scripts, global validation pipe, configuration validation, `.env.example`, Docker Compose, README, and `GET /health`.
- Prisma persistence foundation and a versioned migration.
- Durable message, provider-attempt, transactional-outbox, and expiring-idempotency records.
- Persistence repository that atomically creates a `QUEUED` message and outbox event, while safely returning an existing message for a valid duplicate idempotency key.
- Startup configuration validates only providers selected by `SMS_PROVIDER_PRIORITY`. Twilio-only, Bird-only, and both-provider configurations are covered by tests.

Main implemented paths:

- `src/config/environment.validation.ts`
- `src/database/prisma.service.ts`
- `src/database/sms-persistence.repository.ts`
- `src/database/database.module.ts`
- `prisma/schema.prisma`
- `prisma/migrations/20260904120000_persistence_foundation/migration.sql`

Not implemented:

- Internal `POST /api/v1/sms/send` HTTP contract and private-network enforcement.
- BullMQ queue, outbox relay/reconciliation, worker, retry policy, rate limits, DLQ, requeue, and retention job.
- Provider interfaces, Twilio/Bird adapters, normalized errors, and failover orchestration.
- Authenticated Twilio/Bird webhooks, callback deduplication, and delivery-transition controls.
- Pino privacy-safe logging, encryption implementation, metrics, runbooks, and acceptance/integration suites.

## Important Decisions and Invariants

- PostgreSQL is the durable system of record. Provider calls and queue publication must occur only after the message and outbox event commit.
- Idempotency is valid for 24 hours, but message records are retained for 90 days. The implementation therefore uses a separate expiring idempotency ownership record rather than a permanent unique constraint on historical message rows. Do not replace it with a permanent unique `sms_messages.idempotency_key` constraint.
- A duplicate active idempotency key must return the original record and create neither another message nor another outbox event/delivery.
- Provider attempts are append-only audit records. Timeouts are ambiguous outcomes and must be retained.
- Provider priority is configured by `SMS_PROVIDER_PRIORITY`. On a retryable Twilio failure, attempt Bird immediately. Retry the complete chain only when every provider failed transiently, for at most three configured rounds with exponential backoff.
- Only timeouts, network errors, HTTP 408, HTTP 429, and HTTP 5xx are retryable. Other provider 4xx errors are permanent by default.
- Delivery webhooks may update state only after official signature verification, must be idempotent, and may make only valid transitions.
- SMS content must be encrypted at rest. Never log full phone numbers, bodies, authorization values, or secrets.
- Internal dispatch and DLQ management endpoints must remain private-network-only. Do not add custom service authentication in this challenge.

## Validation Evidence

The latest implementation agent reported successful:

```text
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
npm run prisma:validate
```

The last full unit suite result was 20 passing tests. Prisma client generation and migration structural validation also passed.

## Known Blocker

The migration has not been applied to a clean Docker PostgreSQL database. Docker reported PostgreSQL healthy inside its container, but the configured host port `5432` was unavailable, so `prisma migrate deploy` could not connect.

Resolve this before claiming persistence integration is complete:

1. Inspect `compose.yaml` and the host port owner/binding.
2. Start Docker Compose with an available PostgreSQL host port or update the local `DATABASE_URL` consistently.
3. Run `npm run prisma:migrate` against the clean container database.
4. Add or run an integration test that verifies the atomic message/outbox transaction.
5. Update `to-do.md` only after this succeeds.

## Recommended Next Sequence

1. Delegate a focused infrastructure investigation to resolve the Docker PostgreSQL port and prove migration application.
2. Delegate the HTTP ingestion contract: DTOs, `POST /api/v1/sms/send`, E.164/message/metadata/idempotency validation, private-network guard, 202 response, and API tests. It must use the existing persistence repository and never enqueue/send directly.
3. Delegate provider-contract design/implementation: `ISmsProvider`, normalized failures, Twilio/Bird mockable adapters, registry, and unit tests. Keep provider abstractions independent from queue orchestration.
4. Delegate reliable queue implementation after the provider contract is reviewed: BullMQ setup, transactional-outbox relay/reconciliation, deterministic job IDs, worker state transitions, locking, retry rounds/backoff, per-provider rate limiting, DLQ, and idempotent audited requeue route.
5. Delegate webhook implementation: raw-body support, official signature validation, correlation via provider message ID, deduplication, guarded transitions, and tests.
6. Delegate the cross-cutting security/operations work: field encryption, Pino masking/structured events, metrics, scheduled 90-day retention job, DLQ runbook, and sandbox callback procedure.
7. Commission a final independent review and run lint, formatting, typecheck, build, unit tests, Docker-backed integration tests, and PRD acceptance traceability.

## Local Commands

```powershell
npm install
docker compose up -d
npm run prisma:generate
npm run prisma:migrate
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
npm run prisma:validate
```

Copy `.env.example` to `.env` before normal startup. Use placeholders only; never add real provider credentials to repository files.
