/**
 * Minimal local mock of Bird's Messages API for demonstration and development use only.
 *
 * This mock is not maintained and is intended only for a single demonstration. No real Bird
 * credentials are used or required. See docs/provider-sandbox.md for the demonstration walkthrough.
 *
 * Endpoints:
 *   POST /workspaces/:workspaceId/channels/:channelId/messages
 *     - Mirrors the real Bird "send message" contract that
 *       src/modules/providers/strategies/bird.provider.ts calls.
 *     - Requires header `Authorization: AccessKey <anything>` (any non-empty value passes;
 *       this is a mock, not a real auth check).
 *     - Body: { receiver: { contacts: [{ identifierValue }] }, body: { type, text: { text } }, reference }
 *     - Success: 200 { id: "<generated-id>" }. The id + recipient + body are kept in memory
 *       so /simulate-callback/:messageId can look them up later.
 *     - Forced failure modes via header `X-Mock-Force`:
 *         X-Mock-Force: retryable  -> 503 with a Bird-shaped error body (transient)
 *         X-Mock-Force: permanent  -> 400 with a Bird-shaped error body (permanent)
 *         X-Mock-Force: timeout    -> the request is never answered (socket hangs) so the
 *                                     real provider's own HTTP timeout fires.
 *
 *   POST /simulate-callback/:messageId
 *     - Looks up a previously "sent" message by its mock-generated id.
 *     - Body (optional): { status?: string, eventId?: string }. Defaults to status "delivered".
 *     - Builds a Bird-shaped delivery-report payload and signs it EXACTLY the way
 *       src/modules/webhooks/signature/bird-signature.verifier.ts verifies it:
 *       hex(HMAC-SHA256(BIRD_WEBHOOK_SIGNING_KEY, rawBody)), sent in the `X-Bird-Signature`
 *       header, over the raw JSON body bytes.
 *     - POSTs that payload to `${SERVICE_URL}/webhooks/bird` (the running SMS service) and
 *       returns { forwarded: true, status: <upstream status>, payload } to the caller so a
 *       demo can show the round trip.
 *
 *   GET /health
 *     - Trivial liveness check, returns 200 { ok: true }.
 *
 * Configuration (env vars):
 *   PORT                      - port to listen on (default 8081)
 *   SERVICE_URL               - base URL of the running SMS service (default http://localhost:3000)
 *   BIRD_WEBHOOK_SIGNING_KEY  - must match the real service's BIRD_WEBHOOK_SIGNING_KEY so the
 *                               simulated callback signature verifies. Defaults to the same
 *                               local development value defined in this repository's environment configuration
 *                               ("test-bird-webhook-key"), which is not a real secret.
 */
import { createHmac, randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import express = require('express');

const PORT = Number(process.env.PORT ?? 8081);
const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:3000';
const SIGNING_KEY = process.env.BIRD_WEBHOOK_SIGNING_KEY ?? 'test-bird-webhook-key';

interface StoredMessage {
  id: string;
  workspaceId: string;
  channelId: string;
  to: string;
  text: string;
  reference?: string;
  createdAt: string;
}

const messages = new Map<string, StoredMessage>();

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

app.post('/workspaces/:workspaceId/channels/:channelId/messages', (req: Request, res: Response) => {
  const { workspaceId, channelId } = req.params;
  const authorization = req.header('authorization');

  if (!authorization || !authorization.trim()) {
    res
      .status(401)
      .json({ errors: [{ code: 'unauthorized', description: 'Missing Authorization header' }] });
    return;
  }

  const to = req.body?.receiver?.contacts?.[0]?.identifierValue;
  const text = req.body?.body?.text?.text;
  if (!to || typeof text !== 'string') {
    res.status(400).json({
      errors: [
        {
          code: 'invalid_request',
          description: 'Missing receiver.contacts[0].identifierValue or body.text.text',
        },
      ],
    });
    return;
  }

  const force = (req.header('x-mock-force') ?? '').toLowerCase();

  if (force === 'timeout') {
    // Deliberately never respond and never end the socket, to simulate a hung request.
    return;
  }

  if (force === 'retryable') {
    res.status(503).json({
      errors: [
        {
          code: 'service_unavailable',
          description: 'Mocked transient Bird failure (X-Mock-Force: retryable)',
        },
      ],
    });
    return;
  }

  if (force === 'permanent') {
    res.status(400).json({
      errors: [
        {
          code: 'invalid_receiver',
          description: 'Mocked permanent Bird failure (X-Mock-Force: permanent)',
        },
      ],
    });
    return;
  }

  const id = `bird-mock-${randomUUID()}`;
  messages.set(id, {
    id,
    workspaceId: String(workspaceId),
    channelId: String(channelId),
    to,
    text,
    reference: req.body?.reference,
    createdAt: new Date().toISOString(),
  });

  res.status(200).json({ id });
});

app.get('/messages/:id', (req: Request, res: Response) => {
  const message = messages.get(String(req.params.id));
  if (!message) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(200).json(message);
});

app.post('/simulate-callback/:messageId', async (req: Request, res: Response) => {
  const messageId = String(req.params.messageId);
  const message = messages.get(messageId);
  if (!message) {
    res.status(404).json({ error: 'unknown_message_id', messageId });
    return;
  }

  const status = typeof req.body?.status === 'string' ? req.body.status : 'delivered';
  const eventId = typeof req.body?.eventId === 'string' ? req.body.eventId : randomUUID();

  const payload = { id: message.id, status, eventId };
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf-8');
  const signature = createHmac('sha256', SIGNING_KEY).update(rawBody).digest('hex');

  try {
    const upstream = await fetch(`${SERVICE_URL}/webhooks/bird`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bird-Signature': signature,
      },
      body: rawBody,
    });
    const upstreamBody = await upstream.text();

    res.status(200).json({
      forwarded: true,
      targetUrl: `${SERVICE_URL}/webhooks/bird`,
      payload,
      signature,
      upstreamStatus: upstream.status,
      upstreamBody,
    });
  } catch (error) {
    res.status(502).json({
      forwarded: false,
      targetUrl: `${SERVICE_URL}/webhooks/bird`,
      payload,
      signature,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res
    .status(500)
    .json({ error: 'mock_server_error', detail: err instanceof Error ? err.message : String(err) });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[bird-mock] listening on http://localhost:${PORT} (forwarding callbacks to ${SERVICE_URL})`,
  );
});
