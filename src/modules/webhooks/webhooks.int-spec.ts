import { randomBytes, randomUUID } from 'node:crypto';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';

import { AppModule } from '../../app.module';
import { PrismaService } from '../../database/prisma.service';
import type { SmsMessageStatus } from '../../generated/prisma/client';
import { computeBirdSignature } from './signature/bird-signature.verifier';
import { computeTwilioSignature } from './signature/twilio-signature.verifier';

/**
 * Integration tests for the authenticated Twilio and Bird delivery-report webhooks driven
 * over real HTTP against a live PostgreSQL database. The real Nest application is booted with
 * the SAME global configuration as `src/main.ts` (`rawBody: true` plus a whitelisting,
 * transforming `ValidationPipe`), which is mandatory here: signature verification recomputes
 * an HMAC over the raw request body and would fail without it.
 *
 * Valid signatures are generated in-test using the exact algorithm the verifiers use (their
 * `compute*Signature` helpers) and the signing secrets set in `test/setup-env.integration.ts`
 * (Twilio: base64 HMAC-SHA1 over the callback URL + sorted params; Bird: hex HMAC-SHA256 over
 * the raw JSON body).
 *
 * Requests are issued with axios (supertest is not a dependency). Only the rows created by
 * these tests are removed in `afterAll` via delete-by-id; tables are never truncated.
 */
describe('Webhooks (integration, live PostgreSQL over HTTP)', () => {
  let app: INestApplication;
  let http: AxiosInstance;
  let prisma: PrismaService;
  const createdMessageIds: string[] = [];

  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN as string;
  const birdSigningKey = process.env.BIRD_WEBHOOK_SIGNING_KEY as string;
  // The verifier derives the signed URL from SERVICE_URL, not the ephemeral listen port,
  // so the callback URL used for signing must match the controller's construction exactly.
  const twilioCallbackUrl = `${(process.env.SERVICE_URL as string).replace(/\/+$/, '')}/webhooks/twilio`;

  function uniqueProviderMessageId(): string {
    return `SM${randomBytes(16).toString('hex')}`;
  }

  async function seedMessage(
    providerMessageId: string,
    status: SmsMessageStatus,
    selectedProvider: string,
  ): Promise<string> {
    const message = await prisma.smsMessage.create({
      data: {
        idempotencyKey: `wh-int-${randomUUID()}`,
        recipientPhone: '+14155552671',
        encryptedMessage: 'encrypted-payload',
        status,
        selectedProvider,
        providerMessageId,
        deliveryAttempts: 1,
        retentionExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    createdMessageIds.push(message.id);
    return message.id;
  }

  async function readStatus(messageId: string): Promise<SmsMessageStatus> {
    const row = await prisma.smsMessage.findUniqueOrThrow({
      where: { id: messageId },
      select: { status: true },
    });
    return row.status;
  }

  function postTwilio(
    params: Record<string, string>,
    options: { signature?: string; omitSignature?: boolean } = {},
  ): Promise<AxiosResponse> {
    const body = new URLSearchParams(params).toString();
    const signature =
      options.signature ?? computeTwilioSignature(twilioAuthToken, twilioCallbackUrl, params);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (!options.omitSignature) {
      headers['x-twilio-signature'] = signature;
    }
    return http.post('/webhooks/twilio', body, { headers });
  }

  function postBird(
    payload: Record<string, unknown>,
    options: { signature?: string; omitSignature?: boolean } = {},
  ): Promise<AxiosResponse> {
    const raw = JSON.stringify(payload);
    const signature =
      options.signature ?? computeBirdSignature(birdSigningKey, Buffer.from(raw, 'utf-8'));
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (!options.omitSignature) {
      headers['x-bird-signature'] = signature;
    }
    return http.post('/webhooks/bird', raw, { headers });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );

    await app.init();
    await app.listen(0, '127.0.0.1');

    const baseURL = await app.getUrl();
    http = axios.create({
      baseURL,
      validateStatus: () => true,
    });

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (createdMessageIds.length > 0) {
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: createdMessageIds } } });
      await prisma.smsAttemptResolution.deleteMany({
        where: { smsMessageId: { in: createdMessageIds } },
      });
      await prisma.smsAttempt.deleteMany({ where: { smsMessageId: { in: createdMessageIds } } });
      await prisma.smsIdempotencyKey.deleteMany({
        where: { smsMessageId: { in: createdMessageIds } },
      });
      await prisma.smsMessage.deleteMany({ where: { id: { in: createdMessageIds } } });
    }

    if (app) {
      await app.close();
    }
  });

  describe('Twilio', () => {
    it('applies a valid signed "delivered" callback: SENT -> DELIVERED', async () => {
      const providerMessageId = uniqueProviderMessageId();
      const messageId = await seedMessage(providerMessageId, 'SENT', 'twilio');

      const response = await postTwilio({
        MessageSid: providerMessageId,
        SmsSid: providerMessageId,
        MessageStatus: 'delivered',
      });

      expect(response.status).toBe(200);
      expect(response.data).toEqual({ status: 'ok' });
      expect(await readStatus(messageId)).toBe('DELIVERED');
    });

    it('rejects a callback with an invalid signature (403) and makes no state change', async () => {
      const providerMessageId = uniqueProviderMessageId();
      const messageId = await seedMessage(providerMessageId, 'SENT', 'twilio');

      const response = await postTwilio(
        { MessageSid: providerMessageId, MessageStatus: 'delivered' },
        { signature: 'deadbeefdeadbeefdeadbeefdeadbeef00' },
      );

      expect(response.status).toBe(403);
      expect(await readStatus(messageId)).toBe('SENT');
    });

    it('rejects a callback with a missing signature (403) and makes no state change', async () => {
      const providerMessageId = uniqueProviderMessageId();
      const messageId = await seedMessage(providerMessageId, 'SENT', 'twilio');

      const response = await postTwilio(
        { MessageSid: providerMessageId, MessageStatus: 'delivered' },
        { omitSignature: true },
      );

      expect(response.status).toBe(403);
      expect(await readStatus(messageId)).toBe('SENT');
    });

    it('treats a duplicate valid callback as a harmless no-op (200, no further transition)', async () => {
      const providerMessageId = uniqueProviderMessageId();
      const messageId = await seedMessage(providerMessageId, 'SENT', 'twilio');
      const params = {
        MessageSid: providerMessageId,
        SmsSid: providerMessageId,
        MessageStatus: 'delivered',
      };

      const first = await postTwilio(params);
      expect(first.status).toBe(200);
      expect(await readStatus(messageId)).toBe('DELIVERED');

      const afterFirst = await prisma.smsMessage.findUniqueOrThrow({
        where: { id: messageId },
        select: { status: true, updatedAt: true },
      });

      const second = await postTwilio(params);
      expect(second.status).toBe(200);
      expect(second.data).toEqual({ status: 'ok' });

      const afterSecond = await prisma.smsMessage.findUniqueOrThrow({
        where: { id: messageId },
        select: { status: true, updatedAt: true },
      });
      // A duplicate callback must not re-write the row (no further side effects).
      expect(afterSecond.status).toBe('DELIVERED');
      expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
    });

    it('returns 404 for a valid signed callback with an unknown providerMessageId', async () => {
      const providerMessageId = uniqueProviderMessageId();

      const response = await postTwilio({
        MessageSid: providerMessageId,
        MessageStatus: 'delivered',
      });

      expect(response.status).toBe(404);
    });

    it('returns 409 for a valid callback that requests an invalid transition from a terminal state', async () => {
      const providerMessageId = uniqueProviderMessageId();
      const messageId = await seedMessage(providerMessageId, 'DELIVERED', 'twilio');

      // DELIVERED is terminal: an "undelivered" report is a valid-signature but invalid transition.
      const response = await postTwilio({
        MessageSid: providerMessageId,
        MessageStatus: 'undelivered',
      });

      expect(response.status).toBe(409);
      expect(await readStatus(messageId)).toBe('DELIVERED');
    });

    it('acknowledges a non-terminal status (e.g. "sent") without a state change', async () => {
      const providerMessageId = uniqueProviderMessageId();
      const messageId = await seedMessage(providerMessageId, 'SENT', 'twilio');

      const response = await postTwilio({
        MessageSid: providerMessageId,
        MessageStatus: 'sent',
      });

      expect(response.status).toBe(200);
      expect(response.data).toEqual({ status: 'ignored' });
      expect(await readStatus(messageId)).toBe('SENT');
    });
  });

  describe('Bird', () => {
    // NOTE: Bird's real signing scheme is a documented ASSUMPTION in the production code
    // (bird-signature.verifier.ts / bird-webhook.controller.ts) pending real credentials:
    // HMAC-SHA256 hex over the raw JSON body, correlation id from `id`, status from `status`.
    // These tests exercise exactly that contract.
    it('applies a valid signed "delivered" callback: SENT -> DELIVERED', async () => {
      const providerMessageId = uniqueProviderMessageId();
      const messageId = await seedMessage(providerMessageId, 'SENT', 'bird');

      const response = await postBird({
        id: providerMessageId,
        status: 'delivered',
        eventId: randomUUID(),
      });

      expect(response.status).toBe(200);
      expect(response.data).toEqual({ status: 'ok' });
      expect(await readStatus(messageId)).toBe('DELIVERED');
    });

    it('rejects a callback with an invalid signature (403) and makes no state change', async () => {
      const providerMessageId = uniqueProviderMessageId();
      const messageId = await seedMessage(providerMessageId, 'SENT', 'bird');

      const response = await postBird(
        { id: providerMessageId, status: 'delivered' },
        { signature: 'not-a-valid-signature' },
      );

      expect(response.status).toBe(403);
      expect(await readStatus(messageId)).toBe('SENT');
    });

    it('rejects a callback with a missing signature (403) and makes no state change', async () => {
      const providerMessageId = uniqueProviderMessageId();
      const messageId = await seedMessage(providerMessageId, 'SENT', 'bird');

      const response = await postBird(
        { id: providerMessageId, status: 'delivered' },
        { omitSignature: true },
      );

      expect(response.status).toBe(403);
      expect(await readStatus(messageId)).toBe('SENT');
    });

    it('treats a duplicate valid callback as a harmless no-op (200, no further transition)', async () => {
      const providerMessageId = uniqueProviderMessageId();
      const messageId = await seedMessage(providerMessageId, 'SENT', 'bird');
      const payload = { id: providerMessageId, status: 'delivered', eventId: randomUUID() };

      const first = await postBird(payload);
      expect(first.status).toBe(200);
      expect(await readStatus(messageId)).toBe('DELIVERED');

      const afterFirst = await prisma.smsMessage.findUniqueOrThrow({
        where: { id: messageId },
        select: { updatedAt: true },
      });

      const second = await postBird(payload);
      expect(second.status).toBe(200);
      expect(second.data).toEqual({ status: 'ok' });

      const afterSecond = await prisma.smsMessage.findUniqueOrThrow({
        where: { id: messageId },
        select: { status: true, updatedAt: true },
      });
      expect(afterSecond.status).toBe('DELIVERED');
      expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
    });

    it('returns 404 for a valid signed callback with an unknown providerMessageId', async () => {
      const providerMessageId = uniqueProviderMessageId();

      const response = await postBird({ id: providerMessageId, status: 'delivered' });

      expect(response.status).toBe(404);
    });
  });
});
