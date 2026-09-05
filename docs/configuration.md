# Configuration

All configuration is supplied via environment variables and validated at startup by
`src/config/environment.validation.ts` (Joi). Validation runs with `abortEarly: false`, so a
bad configuration reports **every** problem at once and the process refuses to start. Copy
`.env.example` to `.env` and replace every placeholder before running the service.

## Validated variables

| Variable | Required | Default | Purpose / rules |
| -------- | -------- | ------- | --------------- |
| `NODE_ENV` | No | `development` | One of `development`, `test`, `production`. |
| `PORT` | No | `3000` | HTTP listen port. Must be a valid port number. |
| `SERVICE_URL` | Yes | — | Public base URL (`http`/`https`). Used to reconstruct the Twilio callback URL for signature verification. |
| `PRIVATE_NETWORK_CIDRS` | Yes | — | Comma-separated CIDRs allowed to call private routes including `/api/v1/sms/send` and `/internal/dlq/*`. Matched against the socket remote address. |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string (`postgres`/`postgresql` scheme). |
| `REDIS_URL` | Yes | — | Redis connection string (`redis`/`rediss` scheme). Backs BullMQ. |
| `SMS_PROVIDER_PRIORITY` | Yes | — | Comma-separated provider order. Values must be unique and drawn from `twilio`, `bird` (e.g. `twilio,bird`). Determines failover order and which credentials are required. |
| `TWILIO_ACCOUNT_SID` | Conditional | — | Required only when `twilio` is in `SMS_PROVIDER_PRIORITY`. |
| `TWILIO_AUTH_TOKEN` | Conditional | — | Required for `twilio`. Also the HMAC key for Twilio webhook signatures. |
| `TWILIO_FROM_NUMBER` | Conditional | — | Required for `twilio`. E.164 sender number. |
| `BIRD_API_KEY` | Conditional | — | Required only when `bird` is in `SMS_PROVIDER_PRIORITY`. |
| `BIRD_WORKSPACE_ID` | Conditional | — | Required for `bird`. |
| `BIRD_CHANNEL_ID` | Conditional | — | Required for `bird`. |
| `BIRD_WEBHOOK_SIGNING_KEY` | Conditional | — | Required for `bird`. HMAC-SHA256 key for Bird webhook signatures (assumed scheme). |
| `MAX_MESSAGE_LENGTH` | No | `160` | Positive integer. Max `message` length, enforced in `SmsService`. |
| `IDEMPOTENCY_TTL_HOURS` | No | `24` | Positive integer. Idempotency-key lifetime in hours, applied by `SmsService`/`SmsPersistenceRepository` when creating the idempotency ownership record. Defaults to the PRD-mandated 24h. |
| `PROVIDER_MAX_RETRY_ROUNDS` | No | `3` | Positive integer. Number of full ordered-provider retry rounds before dead-lettering. |
| `SMS_PROVIDER_TPS` | No | `10` | Positive integer. Default per-provider dispatch rate limit. |
| `SMS_PROVIDER_TPS_TWILIO` | No | `SMS_PROVIDER_TPS` | Optional positive integer override for Twilio. |
| `SMS_PROVIDER_TPS_BIRD` | No | `SMS_PROVIDER_TPS` | Optional positive integer override for Bird. |
| `PROCESSING_RECOVERY_INTERVAL_MS` | No | `60000` | Positive integer. BullMQ scheduler interval for stale `PROCESSING` recovery. |
| `PROCESSING_STALE_AFTER_MS` | No | `300000` | Positive integer. A `PROCESSING` row must be older than this before recovery is considered. |
| `PROCESSING_RECOVERY_BATCH_SIZE` | No | `100` | Positive integer. Maximum stale rows considered per recovery run. |
| `AMBIGUOUS_OUTCOME_EXPIRY_MS` | No | `900000` | Positive integer. Delay before an ambiguous provider outcome is finalized as `UNDELIVERED`. The delayed job never resends; a valid webhook received first makes it a no-op. |
| `ENCRYPTION_KEY` | Yes | — | Base64-encoded **32-byte** key for encrypting the SMS body at rest. Validated to decode to exactly 32 bytes. |

Twilio and Bird limits are enforced independently with Redis fixed-window counters immediately
before their respective provider calls. Both providers remain available in the configured priority
order, so a Twilio failure can still fail over to Bird without consuming Bird's quota.

### Provider-credential rule

Credentials are validated **conditionally**: a provider's credentials are required only when
that provider appears in `SMS_PROVIDER_PRIORITY`. If a required credential is missing,
startup fails with `<CREDENTIAL> is required when <provider> is configured`. This lets you run
with a single provider without supplying the other's secrets.

### Generating `ENCRYPTION_KEY`

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

## Advanced tunables

These are read directly via `ConfigService` with built-in defaults. The Joi schema permits
unknown keys (`.unknown(true)`), so they pass validation if set, and fall back to defaults if
absent.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `RETRY_BACKOFF_BASE_MS` | `2000` | Base for exponential retry backoff (`base * 2^round` -> 2s, 4s, 8s). |
| `OUTBOX_RELAY_INTERVAL_MS` | `2000` | Outbox relay poll interval. |
| `OUTBOX_RELAY_BATCH_SIZE` | `50` | Unpublished outbox events drained per relay tick. |

## Secrets hygiene

- Never commit real credentials, webhook signing keys, provider tokens, or phone numbers.
- `.env.example` contains placeholders only; keep it that way.
- The recipient number, message body, authorization values, and webhook secrets are never
  written to logs.
