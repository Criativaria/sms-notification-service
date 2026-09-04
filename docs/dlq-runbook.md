# DLQ Runbook

Operational guide for dead-lettered SMS messages: how they get there, how to inspect them,
and how to replay them.

## How a message reaches the DLQ

The dispatch worker (`SmsProcessor`) moves a message to `FATAL_FAILURE` and atomically records
an outbox intent for the relay to publish to the `sms-dlq` BullMQ queue in three cases:

1. **Permanent failure** — a provider returns a non-retryable error (e.g. a business `4xx`).
   The current ordered pass still tries every remaining configured provider. If none succeeds,
   the message is dead-lettered immediately and no additional retry round is scheduled.
2. **Rounds exhausted** — every configured provider failed transiently across all
   `PROVIDER_MAX_RETRY_ROUNDS` rounds (default 3), with exponential backoff between rounds
   (`RETRY_BACKOFF_BASE_MS * 2^round` -> 2s, 4s, 8s).
3. **Message row missing** — the message row disappeared before dispatch (defensive path).

Only these paths set `FATAL_FAILURE`. Retryable failures schedule `RETRY_SCHEDULED` instead;
provider webhooks never produce `FATAL_FAILURE`.

Queues:

- `sms-dispatch` — normal delivery jobs.
- `sms-dlq` — dead-lettered jobs.

Every job ID is the originating outbox event ID. Replaying an unpublished event therefore safely
reuses its BullMQ job ID, while a later retry, DLQ, or administrative requeue receives a fresh ID.

The application has no consumer for `sms-dlq`; operational requeue is performed through the
PostgreSQL-backed HTTP endpoint below. It also has no configured Redis retention or cleanup for
DLQ jobs, so Redis DLQ entries can accumulate independently of the 90-day PostgreSQL record
retention policy.

## Inspecting the DLQ

A dead-lettered message is durably recorded in PostgreSQL. Inspect it there (the DB is the
system of record — the `sms-dlq` queue is an operational artifact, not the source of truth). No PII is
exposed by lifecycle projections; `lastError` holds the failure reason.

```sql
-- Dead-lettered messages, newest first (no phone number or body selected)
SELECT id, status, selected_provider, provider_message_id,
       last_error, delivery_attempts, retry_rounds, updated_at
FROM sms_messages
WHERE status = 'FATAL_FAILURE'
ORDER BY updated_at DESC;

-- Full provider attempt trail for one message (audit log)
SELECT provider, outcome, is_retryable, is_ambiguous,
       http_status, error_code, error_message, created_at
FROM sms_attempts
WHERE sms_message_id = '<messageId>'
ORDER BY created_at ASC;
```

Structured log lines for the same events (PII-safe) include:
`MESSAGE_DEAD_LETTERED messageId=... reason=permanent|rounds-exhausted|message-missing`,
`PROVIDER_ATTEMPT ...`, and `PROVIDER_FAILOVER messageId=... chain=twilio>bird`.

## Requeuing a message

The requeue endpoint is **private-network only** (gated by `PrivateNetworkGuard` against
`PRIVATE_NETWORK_CIDRS`). Run the request from a host inside an allowed CIDR.

```bash
curl -X POST http://10.0.0.5:3000/internal/dlq/<messageId>/requeue
```

### What the reset does

`SmsLifecycleRepository.resetForRequeue` is an administrative override that bypasses the
normal state machine (where `FATAL_FAILURE` is terminal):

- `status`: `FATAL_FAILURE` -> `RETRY_SCHEDULED`
- `retryRounds`: reset to `0` (full retry budget restored)
- `lastError`: cleared to `null`

The same transaction records a requeue outbox event. The relay later publishes a fresh
`sms-dispatch` job, so Redis unavailability cannot lose the requeue intent. The message re-enters
the pipeline and is dispatched like a normal retry. A provider timeout during that replay remains
an ambiguous delivery outcome: the provider may have accepted the original request, and a later
failover or retry can produce a duplicate SMS.

### Responses

| Status | Meaning |
| ------ | ------- |
| `202 Accepted` | `{ "messageId": "...", "status": "requeued" }` — durable reset and requeue outbox intent accepted; Redis publication is asynchronous |
| `403 Forbidden` | Caller not within an allowed private-network CIDR |
| `404 Not Found` | No message with that id |
| `409 Conflict` | Message is not in `FATAL_FAILURE` (only dead-lettered messages can be requeued) |

### Idempotency of requeue

Requeue is safe to retry. Once a message has been reset out of `FATAL_FAILURE`, a second
requeue call for the same id returns `409 Conflict` (its status is no longer
`FATAL_FAILURE`), so a repeated or accidental call cannot enqueue a duplicate delivery. If the
message reaches `FATAL_FAILURE` again after a failed replay, it can be requeued again.
