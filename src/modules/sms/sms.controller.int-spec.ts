import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import axios, { type AxiosInstance } from 'axios';

import { AppModule } from '../../app.module';
import { PrismaService } from '../../database/prisma.service';

interface AcceptedSmsEnvelope {
  status: string;
  data: {
    messageId: string;
    status: string;
    createdAt: string;
  };
}

/**
 * Integration tests for `POST /api/v1/sms/send` driven over real HTTP against a
 * live PostgreSQL database. The real Nest application is booted with the same
 * global configuration as `src/main.ts` (rawBody plus a whitelisting,
 * transforming `ValidationPipe`) and listens on an ephemeral loopback port so
 * the `PrivateNetworkGuard` accepts the caller.
 *
 * Requests are issued with axios (supertest is not a dependency). Only the rows
 * created by these tests are removed in `afterAll` via delete-by-id using unique
 * idempotency keys; tables are never truncated.
 */
describe('SmsController (integration, live PostgreSQL over HTTP)', () => {
  let app: INestApplication;
  let http: AxiosInstance;
  let prisma: PrismaService;
  const createdMessageIds: string[] = [];

  function uniqueKey(): string {
    return `int-api-${Date.now()}-${randomUUID()}`;
  }

  const validBody = {
    to: '+14155552671',
    message: 'Integration test message',
    metadata: { source: 'sms-controller-int-spec' },
  };

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

    const server = app.getHttpServer() as Server;
    const address = server.address() as AddressInfo;
    http = axios.create({
      baseURL: `http://127.0.0.1:${address.port}`,
      validateStatus: () => true,
    });

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (createdMessageIds.length > 0) {
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: createdMessageIds } } });
      await prisma.smsIdempotencyKey.deleteMany({
        where: { smsMessageId: { in: createdMessageIds } },
      });
      await prisma.smsAttempt.deleteMany({ where: { smsMessageId: { in: createdMessageIds } } });
      await prisma.smsMessage.deleteMany({ where: { id: { in: createdMessageIds } } });
    }

    if (app) {
      await app.close();
    }
  });

  it('accepts a valid request and returns 202 with the expected envelope', async () => {
    const key = uniqueKey();

    const response = await http.post<AcceptedSmsEnvelope>('/api/v1/sms/send', validBody, {
      headers: { 'X-Idempotency-Key': key },
    });

    expect(response.status).toBe(202);
    expect(response.data.status).toBe('success');
    expect(Object.keys(response.data.data).sort()).toEqual(['createdAt', 'messageId', 'status']);
    expect(typeof response.data.data.messageId).toBe('string');
    expect(response.data.data.status).toBe('QUEUED');
    expect(typeof response.data.data.createdAt).toBe('string');

    const messageId = response.data.data.messageId;
    createdMessageIds.push(messageId);

    // createdAt must be a valid ISO-8601 timestamp.
    expect(Number.isNaN(Date.parse(response.data.data.createdAt))).toBe(false);

    const rows = await prisma.smsMessage.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(messageId);
    expect(rows[0]!.status).toBe('QUEUED');
  });

  it('rejects a request without the X-Idempotency-Key header with 400', async () => {
    const response = await http.post('/api/v1/sms/send', validBody);

    expect(response.status).toBe(400);
  });

  it('rejects a non-E.164 recipient with 400', async () => {
    const key = uniqueKey();

    const response = await http.post(
      '/api/v1/sms/send',
      { ...validBody, to: '5551234' },
      { headers: { 'X-Idempotency-Key': key } },
    );

    expect(response.status).toBe(400);

    const rows = await prisma.smsMessage.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(0);
  });

  it('rejects a message longer than the configured limit (160) with 400', async () => {
    const key = uniqueKey();

    const response = await http.post(
      '/api/v1/sms/send',
      { ...validBody, message: 'a'.repeat(161) },
      { headers: { 'X-Idempotency-Key': key } },
    );

    expect(response.status).toBe(400);

    const rows = await prisma.smsMessage.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(0);
  });

  it('rejects metadata that is not a JSON object with 400', async () => {
    const key = uniqueKey();

    const response = await http.post(
      '/api/v1/sms/send',
      { ...validBody, metadata: 'not-an-object' },
      { headers: { 'X-Idempotency-Key': key } },
    );

    expect(response.status).toBe(400);

    const rows = await prisma.smsMessage.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(0);
  });

  it('rejects metadata that is a JSON array (not a plain object) with 400', async () => {
    const key = uniqueKey();

    const response = await http.post(
      '/api/v1/sms/send',
      { ...validBody, metadata: ['not', 'an', 'object'] },
      { headers: { 'X-Idempotency-Key': key } },
    );

    expect(response.status).toBe(400);

    const rows = await prisma.smsMessage.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(0);
  });

  it('returns the original messageId for a sequential duplicate and creates no new row', async () => {
    const key = uniqueKey();

    const first = await http.post<AcceptedSmsEnvelope>('/api/v1/sms/send', validBody, {
      headers: { 'X-Idempotency-Key': key },
    });
    expect(first.status).toBe(202);
    const messageId = first.data.data.messageId;
    createdMessageIds.push(messageId);

    const second = await http.post<AcceptedSmsEnvelope>('/api/v1/sms/send', validBody, {
      headers: { 'X-Idempotency-Key': key },
    });
    expect(second.status).toBe(202);
    expect(second.data.data.messageId).toBe(messageId);

    const rows = await prisma.smsMessage.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(messageId);
  });

  it('returns a single messageId for concurrent duplicates and creates exactly one row', async () => {
    const key = uniqueKey();
    const concurrentRequests = 5;

    const responses = await Promise.all(
      Array.from({ length: concurrentRequests }, () =>
        http.post<AcceptedSmsEnvelope>('/api/v1/sms/send', validBody, {
          headers: { 'X-Idempotency-Key': key },
        }),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(202);
    }

    const messageIds = responses.map((response) => response.data.data.messageId);
    const uniqueMessageIds = new Set(messageIds);
    expect(uniqueMessageIds.size).toBe(1);

    const [messageId] = messageIds;
    createdMessageIds.push(messageId!);

    const rows = await prisma.smsMessage.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(messageId);
  });
});
