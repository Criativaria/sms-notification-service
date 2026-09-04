# Agent Guidance

## Project Context

This repository is a coding challenge for a Canadian employer. The required product is a standalone NestJS SMS Notification Microservice. `SMS Notification Service PRD.pdf` is the highest-priority source of truth. `PLAN.md` and `to-do.md` record the approved implementation plan and execution checklist.

All source code, documentation, code comments, commit messages, API responses, logs, and test descriptions must be written in English.

## Scope

Implement only the first release defined by the PRD:

- NestJS and TypeScript.
- PostgreSQL with Prisma.
- Redis and BullMQ.
- Twilio and Bird Messaging API providers.
- Idempotent internal dispatch endpoint.
- Provider failover, retries, DLQ, and DLQ requeue.
- Authenticated Twilio and Bird delivery webhooks.
- Structured, privacy-safe observability.

Do not add UI, campaigns, scheduling, bulk sends, extra channels, gRPC, AMQP, Kafka, cloud deployment, or CI unless explicitly requested.

## Required Decisions

- Build a standalone microservice, not a monolith module.
- Use `POST /api/v1/sms/send` with body fields `to`, `message`, optional `metadata`, and header `X-Idempotency-Key`.
- Validate E.164 phone numbers and use a configurable message limit with a 160-character default.
- Treat idempotency keys as valid for 24 hours. Reusing a key returns the original record and never re-sends.
- Use PostgreSQL as the durable system of record and a transactional outbox to bridge database writes to BullMQ safely.
- Configure providers through `SMS_PROVIDER_PRIORITY=twilio,bird` and validate the configuration on startup.
- For a retryable Twilio failure, try Bird immediately. Retry the complete ordered provider chain for up to three rounds using exponential backoff only when all providers fail transiently.
- Retry only timeouts, network errors, HTTP 408, HTTP 429, and HTTP 5xx errors. Treat other provider 4xx business errors as permanent by default.
- Use a configurable 10 TPS default limiter per provider.
- Encrypt SMS body at rest, mask phone numbers and message bodies in logs, and purge retained records after 90 days through a BullMQ scheduled job.
- Keep internal dispatch and DLQ management routes private-network-only. Do not add custom authentication for this challenge.
- Keep service-to-service authentication as a deferred enhancement: API key, JWT service token, or mTLS.
- Implement Bird with explicit environment placeholders until credentials are supplied; use mocks for automated tests.
- Use Docker Compose for local PostgreSQL and Redis. Do not add cloud infrastructure or CI.

## Reliability Invariants

- Never call a provider before the message and its outbox event are committed to PostgreSQL.
- Never enqueue a second delivery for an existing idempotency key.
- Preserve every provider attempt in the audit trail.
- A provider timeout is an ambiguous delivery outcome. Record it; do not hide it in logs.
- Move a message to `FATAL_FAILURE` and the DLQ only after all configured providers and allowed retry rounds are exhausted.
- Webhooks can set delivery outcomes only after official signature validation.
- Webhook processing must be idempotent and permit only valid state transitions.

## Suggested Module Layout

```text
src/
  config/
  database/
  modules/
    sms/
      dto/
      sms.controller.ts
      sms.service.ts
    queue/
      outbox.relay.ts
      sms.processor.ts
    providers/
      interfaces/
      strategies/
      provider-manager.ts
    webhooks/
```

Prefer small NestJS modules with explicit dependencies. New providers must implement `ISmsProvider` and be registered in the provider registry. Do not modify core orchestration logic for a new provider.

## Security and Secrets

- Never commit credentials, webhook secrets, provider tokens, or real phone numbers.
- Keep placeholders in `.env.example`.
- Validate webhook signatures using raw request bodies where required by the provider.
- Do not log the full recipient number, message text, authorization values, or webhook secrets.
- Preserve the private-network boundary for internal routes; public exposure is limited to provider webhooks.

## Verification Standard

Before declaring work complete, run the narrowest relevant checks and then the full project suite when available:

- Linting and formatting checks.
- Type checking.
- Unit tests for provider and orchestration behavior.
- Integration tests against Docker Compose PostgreSQL and Redis.
- Tests for idempotency, outbox recovery, retries, failover, DLQ, requeue, and webhook signatures.

The PRD acceptance criteria must be traceable to automated tests or, only where credentials are unavailable, documented sandbox verification steps.

Keep `to-do.md` updated in real time: mark an item complete only after its implementation and relevant validation pass; record blockers and partial progress accurately; never mark unfinished or unverified integration work complete.
