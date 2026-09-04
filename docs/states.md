# Message State Machine

The canonical lifecycle is defined in `src/database/sms-state-machine.ts` and enforced by
`SmsLifecycleRepository`. Every status change is validated against the transition table and
applied inside a transaction with an optimistic-concurrency `where` clause on the current
status, so duplicated lifecycle operations cannot double-advance a message. Twilio invocation is
also protected by a durable attempt reservation: a timeout or worker replay cannot automatically
issue the same Twilio request again.

## Statuses

| Status                     | Meaning                                                                                              | Terminal |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| `QUEUED`                   | Accepted and persisted; awaiting the first dispatch                                                  | No       |
| `RETRY_SCHEDULED`          | A retryable failure occurred; a delayed retry outbox intent is durable and awaits relay publication  | No       |
| `PROCESSING`               | Claimed by a worker; a provider pass is in flight                                                    | No       |
| `AWAITING_PROVIDER_RESULT` | A Twilio attempt was durably reserved and invoked; automated replay, retry, and failover are blocked | No       |
| `SENT`                     | A provider accepted the message; awaiting a delivery webhook                                         | No       |
| `DELIVERED`                | Provider confirmed delivery via signed webhook                                                       | Yes      |
| `UNDELIVERED`              | Provider reported non-delivery (webhook or exhausted permanent failure)                              | Yes      |
| `REJECTED`                 | Provider rejected the message (webhook or permanent failure)                                         | Yes      |
| `FATAL_FAILURE`            | All providers and retry rounds exhausted; dead-lettered                                              | Yes      |

## Allowed transitions

Mirrors the `transitionTable` exactly:

| From                       | Allowed next states                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `QUEUED`                   | `PROCESSING`                                                                              |
| `RETRY_SCHEDULED`          | `PROCESSING`                                                                              |
| `PROCESSING`               | `AWAITING_PROVIDER_RESULT`, `RETRY_SCHEDULED`, `REJECTED`, `UNDELIVERED`, `FATAL_FAILURE` |
| `AWAITING_PROVIDER_RESULT` | `SENT`                                                                                    |
| `SENT`                     | `DELIVERED`, `UNDELIVERED`, `REJECTED`                                                    |
| `DELIVERED`                | _(terminal — none)_                                                                       |
| `FATAL_FAILURE`            | _(terminal — none)_                                                                       |
| `REJECTED`                 | _(terminal — none)_                                                                       |
| `UNDELIVERED`              | _(terminal — none)_                                                                       |

```text
QUEUED ─────────────┐
                    ▼
RETRY_SCHEDULED ──► PROCESSING ──► AWAITING_PROVIDER_RESULT ──► SENT ──► DELIVERED   (terminal)
        ▲               │                        │                    │  └──► UNDELIVERED (terminal)
        │               │                        │                    └─────► REJECTED    (terminal)
        │               ├─► RETRY_SCHEDULED      └─► explicit audited operator action required
        │               ├─► REJECTED        (terminal)
        │               ├─► UNDELIVERED     (terminal)
        │               └─► FATAL_FAILURE   (terminal, dead-lettered)
        │                        │
        └──── administrative requeue (resetForRequeue) ◄─┘
```

## Who sets each transition

### Dispatch worker (`SmsProcessor` / `SmsLifecycleRepository`)

- `QUEUED` / `RETRY_SCHEDULED` -> `PROCESSING` — `beginProcessing`. A conditional
  `updateMany` claims the message; only one worker can win, so a duplicate job is a no-op
  (`skipped`).
- `PROCESSING` -> `AWAITING_PROVIDER_RESULT` — `reserveTwilioAttempt`, atomically creates a
  `RESERVED` Twilio attempt and makes the message non-dispatchable before `sendSms` is called.
- `AWAITING_PROVIDER_RESULT` -> `SENT` — `finalizeTwilioAttempt`, atomically finalizes that
  reservation as accepted and stores the Twilio message id.
- `PROCESSING` -> `RETRY_SCHEDULED` — `scheduleRetry`, on a retryable failure when retry
  rounds remain; increments `retryRounds` and atomically records a delayed retry outbox intent.
  The relay publishes the retry after the transaction commits.
- `PROCESSING` -> `FATAL_FAILURE` — `markFatalFailure`, on a permanent (non-retryable)
  failure, when all retry rounds are exhausted, or when the message row disappears before
  dispatch. Also atomically records a DLQ outbox intent for relay publication.

### Ambiguous Twilio recovery

After `reserveTwilioAttempt`, the worker never automatically retries Twilio or fails over. This
includes timeouts, network failures, duplicate jobs, worker/process restart-like replay, and a
database error while finalizing a result. An unresolved `AWAITING_PROVIDER_RESULT` row requires an
explicit audited operator decision. This release does not implement Twilio provider lookup or
callback correlation for those reservations; do not infer that an unresolved attempt was delivered
or rejected from this state alone.

### Delivery webhooks (`WebhooksService` / `SmsLifecycleRepository.applyDeliveryReport`)

- `SENT` -> `DELIVERED` | `UNDELIVERED` | `REJECTED` — only after successful provider
  signature validation, mapping the provider status to a canonical terminal status.
- A callback reporting the **same** status the message already holds is a no-op
  (`duplicate`, `200`). A callback whose status is not a valid transition from the current
  status yields `409 Conflict` (`invalid_transition`).

## DLQ and administrative requeue

A message reaches `FATAL_FAILURE` (and the `sms-dlq` queue) only after either a permanent
provider failure or exhaustion of all providers across `PROVIDER_MAX_RETRY_ROUNDS` rounds.

Because `FATAL_FAILURE` is terminal, the DLQ requeue endpoint uses
`SmsLifecycleRepository.resetForRequeue`, which **deliberately bypasses** the transition
guard:

- `FATAL_FAILURE` -> `RETRY_SCHEDULED`
- `retryRounds` reset to `0` (full retry budget restored)
- `lastError` cleared to `null`

The reset atomically records a requeue outbox intent. The relay later publishes a fresh dispatch
job, so the message re-enters the normal machine at `RETRY_SCHEDULED`. A successful requeue
response confirms the durable reset and outbox intent, not that Redis already contains the job.
This reset path is reachable **only** from the private-network DLQ endpoint.
See `docs/dlq-runbook.md`.
