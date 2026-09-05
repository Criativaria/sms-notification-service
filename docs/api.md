# API Reference

All routes are served from the service root (no global path prefix). Base URL in local
development is `http://localhost:3000`.

| Method | Path                               | Purpose                         | Network                     |
| ------ | ---------------------------------- | ------------------------------- | --------------------------- |
| `GET`  | `/health`                          | Liveness probe                  | Public                      |
| `POST` | `/api/v1/sms/send`                 | Accept an SMS for delivery      | Private-network only        |
| `POST` | `/webhooks/twilio`                 | Twilio delivery-status callback | Public (signature-verified) |
| `POST` | `/webhooks/bird`                   | Bird delivery-status callback   | Public (signature-verified) |
| `POST` | `/internal/dlq/:messageId/requeue` | Replay a dead-lettered message  | Private-network only        |

Private-network routes are gated by `PrivateNetworkGuard`, which matches the socket remote
address (never `X-Forwarded-For`) against `PRIVATE_NETWORK_CIDRS`. A caller outside those
CIDRs receives `403 Forbidden`.

---

## POST /api/v1/sms/send

Accepts a message, persists it durably, and returns immediately with `202 Accepted`. Actual
provider delivery happens asynchronously via the outbox relay and dispatch worker.

### Headers

| Header              | Required | Notes                                                                                                                                               |
| ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Idempotency-Key` | Yes      | Non-empty (trimmed) string. Missing or blank -> `400`. Valid for 24 hours; reusing an unexpired key returns the original record and never re-sends. |
| `Content-Type`      | Yes      | `application/json`                                                                                                                                  |

### Body

| Field      | Type   | Required | Validation                                                                                                                       |
| ---------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `to`       | string | Yes      | Strict E.164: `^\+[1-9]\d{1,14}$`                                                                                                |
| `message`  | string | Yes      | Non-empty; length `<= MAX_MESSAGE_LENGTH` (default 160). Enforced in the service against runtime config, not a static decorator. |
| `metadata` | object | No       | Arbitrary JSON object                                                                                                            |

The global `ValidationPipe` runs with `whitelist: true`, so unknown body properties are
stripped rather than rejected.

```bash
curl -X POST http://localhost:3000/api/v1/sms/send \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: 6f9d1c2a-0001-4a2b-9f3e-0a1b2c3d4e5f" \
  -d '{
    "to": "+15551234567",
    "message": "Your verification code is 123456",
    "metadata": { "template": "otp" }
  }'
```

### Success — 202 Accepted

```json
{
  "status": "success",
  "data": {
    "messageId": "b3f1e5a2-7c94-4d1e-8f2a-1c2d3e4f5a6b",
    "status": "QUEUED",
    "createdAt": "2026-09-04T12:34:56.789Z"
  }
}
```

`data.status` is the persisted lifecycle status at acceptance time — always `QUEUED` for a
newly created message, or the original status when an idempotency key is replayed.

### Idempotency behavior

- The idempotency key, the message row, and the outbox event are written in a single
  transaction, so a message can never be enqueued without its durable record.
- A repeat request with the **same unexpired key** returns the original `messageId`/`status`/
  `createdAt` with `202` and enqueues nothing new.
- Once a key's 24-hour window has expired, the same key value creates a fresh message.
- A concurrent duplicate that loses the unique-constraint race is retried transparently and
  resolves to the same original record.

### Validation errors — 400 Bad Request

| Cause                             | Message                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| Missing/blank `X-Idempotency-Key` | `X-Idempotency-Key header is required`                                   |
| Invalid `to`                      | `to must be a valid E.164 phone number`                                  |
| Empty `message`                   | `message should not be empty`                                            |
| `message` too long                | `message must be at most 160 characters` (reflects the configured limit) |

```json
{
  "statusCode": 400,
  "message": ["to must be a valid E.164 phone number"],
  "error": "Bad Request"
}
```

### Other responses

| Status          | Cause                                                |
| --------------- | ---------------------------------------------------- |
| `403 Forbidden` | Caller is not within an allowed private-network CIDR |

---

## Webhook endpoints

Both webhooks require the raw request body (`NestFactory` is created with `{ rawBody: true }`)
for signature verification, map the provider's status to a canonical terminal status, and
delegate a guarded state transition. Neither endpoint logs PII.

Both return `200 OK` with one of:

```json
{ "status": "ok" }
```

```json
{ "status": "ignored" }
```

`ignored` means the provider status is non-terminal or unrecognized (e.g. Twilio `queued`,
`sending`, `sent`, `accepted`) — the message is acknowledged with no state change.

### POST /webhooks/twilio

- Authenticated by recomputing `base64(HMAC-SHA1(TWILIO_AUTH_TOKEN, url + sorted(key+value)))`
  over the callback URL (`SERVICE_URL` + `/webhooks/twilio`) plus form parameters, and
  constant-time comparing to the `X-Twilio-Signature` header.
- Correlation id comes from the `MessageSid` form field (persisted as `providerMessageId`).
- Status mapping (`MessageStatus`, case-insensitive):

  | Twilio status | Canonical           |
  | ------------- | ------------------- |
  | `delivered`   | `DELIVERED`         |
  | `undelivered` | `UNDELIVERED`       |
  | `failed`      | `REJECTED`          |
  | anything else | ignored (no change) |

### POST /webhooks/bird

- Authenticated by `hex(HMAC-SHA256(BIRD_WEBHOOK_SIGNING_KEY, rawBody))`, constant-time
  compared to the `X-Bird-Signature` header. **This signature scheme and header name are an
  assumption** pending real Bird docs/credentials (see `docs/provider-sandbox.md`).
- JSON body. Correlation id read from `id`, falling back to `messageId` then `message.id`.
  Status read from `status`, falling back to `message.status`.
- Status mapping (case-insensitive):

  | Bird status                                | Canonical           |
  | ------------------------------------------ | ------------------- |
  | `delivered`                                | `DELIVERED`         |
  | `delivery_failed`, `failed`, `undelivered` | `UNDELIVERED`       |
  | `rejected`                                 | `REJECTED`          |
  | anything else                              | ignored (no change) |

### Webhook response codes

| Status            | Cause                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `200 OK`          | Applied, duplicate (same-state repeat callback), or ignored (non-terminal status)            |
| `400 Bad Request` | Missing raw body; missing `MessageSid` (Twilio) / correlation id (Bird); invalid JSON (Bird) |
| `403 Forbidden`   | Signature missing or invalid                                                                 |
| `404 Not Found`   | No message matches the provider correlation id                                               |
| `409 Conflict`    | Reported status conflicts with the current lifecycle status (invalid transition)             |

A repeated callback that reports the **same** status the message already holds returns `200`
(`duplicate`), making webhook processing idempotent.

---

## POST /internal/dlq/:messageId/requeue

Private-network-only operational endpoint that replays a dead-lettered (`FATAL_FAILURE`)
message. See `docs/dlq-runbook.md` for the full runbook.

```bash
curl -X POST http://10.0.0.5:3000/internal/dlq/b3f1e5a2-7c94-4d1e-8f2a-1c2d3e4f5a6b/requeue
```

### Success — 202 Accepted

```json
{
  "messageId": "b3f1e5a2-7c94-4d1e-8f2a-1c2d3e4f5a6b",
  "status": "requeued"
}
```

The reset moves the message from `FATAL_FAILURE` to `RETRY_SCHEDULED`, restores a full retry
budget (`retryRounds = 0`), clears `lastError`, and atomically records a requeue outbox intent.
The relay publishes the fresh dispatch job after commit.

### Other responses

| Status          | Cause                                                                           |
| --------------- | ------------------------------------------------------------------------------- |
| `403 Forbidden` | Caller is not within an allowed private-network CIDR                            |
| `404 Not Found` | No message with that id                                                         |
| `409 Conflict`  | Message is not in `FATAL_FAILURE` (only dead-lettered messages can be requeued) |
