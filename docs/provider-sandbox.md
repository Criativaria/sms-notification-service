# Provider Sandbox Verification

Automated tests use mocked providers. This procedure describes the **manual** end-to-end
verification against real provider credentials and a temporary public callback tunnel, for
the delivery paths that cannot be exercised without live provider accounts.

> No real credentials, tokens, or phone numbers belong in this repository. Use placeholders in
> `.env.example` and keep real values only in a local, untracked `.env`.

## Prerequisites

- A real provider account (Twilio and/or Bird) with sending credentials.
- A tunnelling tool that exposes `http://localhost:3000` on a temporary public HTTPS URL
  (e.g. an SSH reverse tunnel, `cloudflared`, or a similar ngrok-style tool).
- Local PostgreSQL and Redis running (`docker compose up -d`).

## Twilio sandbox walkthrough

1. **Set real credentials** in `.env`:
   - `SMS_PROVIDER_PRIORITY=twilio` (isolate Twilio for the test)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` with real values.
2. **Expose the callback.** Start the tunnel and set `SERVICE_URL` to the public HTTPS origin
   it hands you (for example `https://<subdomain>.example-tunnel.dev`). `SERVICE_URL` must
   match exactly, because the Twilio signature is computed over `SERVICE_URL + /webhooks/twilio`.
   Restart the service so the new `SERVICE_URL` takes effect.
3. **Register the status callback.** Configure the Twilio number / messaging service to POST
   delivery status callbacks to `https://<public-origin>/webhooks/twilio`.
4. **Send a real message** from a private-network host:
   ```bash
   curl -X POST http://localhost:3000/api/v1/sms/send \
     -H "Content-Type: application/json" \
     -H "X-Idempotency-Key: sandbox-twilio-001" \
     -d '{ "to": "+1<your-test-number>", "message": "Sandbox delivery test" }'
   ```
5. **Observe the lifecycle.** The message should progress `QUEUED -> PROCESSING -> SENT`
   once Twilio accepts it, then advance to `DELIVERED` (or `UNDELIVERED` / `REJECTED`) when
   the signed status callback arrives at `/webhooks/twilio`. Confirm via the database:
   ```sql
   SELECT id, status, selected_provider, provider_message_id, updated_at
   FROM sms_messages WHERE idempotency_key = 'sandbox-twilio-001';
   ```
   A valid signature yields `200 {"status":"ok"}`; an invalid one yields `403`.

## Bird sandbox walkthrough — ASSUMPTION PENDING REAL DOCS

The service currently verifies Bird callbacks with an **assumed** scheme:

- Header: `X-Bird-Signature`
- Signature: `hex(HMAC-SHA256(BIRD_WEBHOOK_SIGNING_KEY, rawRequestBody))`

Bird's real signing scheme, header name, and delivery-report payload shape are **not
confirmed** (no live Bird docs/credentials were available). Treat the Bird path as
provisional until verified against real Bird documentation and a live account.

To verify once real Bird access is available:

1. Set `SMS_PROVIDER_PRIORITY=bird` and real `BIRD_API_KEY`, `BIRD_WORKSPACE_ID`,
   `BIRD_CHANNEL_ID`, `BIRD_WEBHOOK_SIGNING_KEY`.
2. Expose `/webhooks/bird` via the tunnel and register it as Bird's delivery-report URL.
3. Send a real message (as above) and confirm `SENT -> DELIVERED` on the signed callback.
4. **Reconcile the assumption.** If Bird's real header name, digest encoding, or payload
   fields differ, update `src/modules/webhooks/signature/bird-signature.verifier.ts`
   (encoding/header) and `src/modules/webhooks/bird-webhook.controller.ts` (payload
   correlation-id / status extraction). The controller and service are decoupled from the
   signature choice, so only the verifier and payload mapping need to change.

## Cleanup

- Stop the tunnel and revert `SERVICE_URL` to the local value.
- Remove real credentials from `.env`; never commit them.
- Restore `SMS_PROVIDER_PRIORITY` to the intended production order.

## Bird local mock server (for demo / no live Bird credentials)

Bird's API is paid, so for local development and the live demo we run a small standalone
mock of the Bird Messages API instead of using real credentials. Source:
`mock-servers/bird/server.ts`. It is a throwaway helper for this presentation, not a
maintained service — no real Bird account, workspace, or channel is involved.

### What it implements

- `POST /workspaces/:workspaceId/channels/:channelId/messages` — mirrors the request/response
  shape `BirdProvider` sends: requires a non-empty `Authorization: AccessKey ...` header,
  reads `receiver.contacts[0].identifierValue` and `body.text.text`, and on success returns
  `200 { id: "bird-mock-<uuid>" }`. The id, recipient, and body text are kept in memory.
- Forced failure modes via the `X-Mock-Force` request header, so failover / retry paths can be
  demoed without waiting on real network conditions:
  - `X-Mock-Force: retryable` -> `503` with a Bird-shaped `{ errors: [...] }` body (transient).
  - `X-Mock-Force: permanent` -> `400` with a Bird-shaped `{ errors: [...] }` body (permanent).
  - `X-Mock-Force: timeout` -> the request is never answered (the socket just hangs), so the
    real provider's own HTTP timeout (`resolveProviderTimeoutMs`) fires.
- `POST /simulate-callback/:messageId` — looks up a message previously "sent" through the mock,
  builds a Bird-shaped delivery-report payload `{ id, status, eventId }` (default
  `status: "delivered"`, override via request body), and signs it **exactly** the way
  `src/modules/webhooks/signature/bird-signature.verifier.ts` verifies it:
  `hex(HMAC-SHA256(BIRD_WEBHOOK_SIGNING_KEY, rawBody))` sent in the `X-Bird-Signature` header
  over the raw JSON bytes. It then POSTs that payload to `${SERVICE_URL}/webhooks/bird` (the
  real running SMS service) and returns the forwarding result (`upstreamStatus`,
  `upstreamBody`) so you can see the round trip.
- `GET /messages/:id` — debugging helper to inspect a stored mock message.
- `GET /health` — liveness check.

### Starting it

```bash
docker compose up -d bird-mock
```

This runs `npx ts-node mock-servers/bird/server.ts` inside a `node:22-alpine` container with
the repo bind-mounted, listening on `http://localhost:8081`. It reaches the main app (which
runs on the host via `npm run start:dev`, not in this compose network) at
`http://host.docker.internal:3000` by default — override with `BIRD_MOCK_SERVICE_URL` if the
app's `SERVICE_URL`/port differ. You can also run it directly on the host instead:

```bash
PORT=8081 npx ts-node mock-servers/bird/server.ts
```

`BIRD_API_BASE_URL=http://localhost:8081` is set in `.env` (and documented, commented, in
`.env.example`) so `BirdProvider` sends to the mock instead of `https://api.bird.com` once the
orchestrator's configurable-base-URL change lands. `BIRD_WEBHOOK_SIGNING_KEY` must be the same
value on both the app and the mock (already the case via `.env`: `test-bird-webhook-key`) so
the simulated callback signature verifies.

### Demoing live failover + delivery webhook

1. Start Postgres/Redis/bird-mock: `docker compose up -d`.
2. Start the app: `npm run start:dev`.
3. Force Bird to fail so Twilio->Bird failover (or vice versa, depending on
   `SMS_PROVIDER_PRIORITY`) is visible — either point `TWILIO_API_BASE_URL` at a failing target
   for a Twilio-first failure, or send straight to Bird with a forced failure header (the mock
   only reacts to `X-Mock-Force`, which the app itself does not forward, so to force a *Bird*
   failure during a real end-to-end run temporarily set `SMS_PROVIDER_PRIORITY=bird` and hit the
   mock directly to pre-validate the header behavior, or add a short-lived proxy/manual curl
   against the mock to confirm the 503/400/timeout paths shown above).
4. Send a message: `curl -X POST http://localhost:3000/api/v1/sms/send -H "Content-Type: application/json" -H "X-Idempotency-Key: demo-001" -d '{ "to": "+15005550006", "message": "Demo message" }'`.
5. Confirm it reached `SENT` via Bird (or Twilio) and note the `provider_message_id` — that is
   the mock's `bird-mock-<uuid>` id when Bird was selected.
6. Trigger the delivery webhook: `curl -X POST http://localhost:8081/simulate-callback/<provider_message_id> -H "Content-Type: application/json" -d '{"status":"delivered"}'`.
7. Confirm the message transitions to `DELIVERED` in the database (same query as the Twilio
   walkthrough above, `WHERE idempotency_key = 'demo-001'`).

### Status

Implemented and manually verified (2026-09-04): send endpoint returns `200 { id }` with a
valid `Authorization` header and rejects with `401` when it is missing; `X-Mock-Force:
retryable|permanent` return `503`/`400` respectively and `X-Mock-Force: timeout` hangs the
connection (verified via `curl --max-time`, confirmed timeout). `/simulate-callback/:messageId`
was verified against a Node one-liner that recomputes
`hex(HMAC-SHA256(BIRD_WEBHOOK_SIGNING_KEY, rawBody))` independently — the signatures matched
byte-for-byte. Verified both running directly via `ts-node` on the host and via
`docker compose up -d bird-mock`. **Not yet verified**: an actual `200 {"status":"ok"}` from
the real running NestJS app's `/webhooks/bird` endpoint (the app was not running during this
change, since it depends on a parallel effort's `bird.provider.ts` / `twilio.provider.ts` base
URL change) — the signature algorithm match against `bird-signature.verifier.ts` gives high
confidence it will verify correctly once exercised end-to-end.
