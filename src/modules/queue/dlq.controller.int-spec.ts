import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import axios, { type AxiosInstance } from 'axios';

import { AppModule } from '../../app.module';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { PrismaService } from '../../database/prisma.service';
import { SmsLifecycleRepository } from '../../database/sms-lifecycle.repository';
import { SmsPersistenceRepository } from '../../database/sms-persistence.repository';

/**
 * Integration coverage for `POST /internal/dlq/:messageId/requeue` driven over real HTTP
 * against a live PostgreSQL database, mirroring the pattern in
 * `../sms/sms.controller.int-spec.ts`. Unlike `dlq.controller.spec.ts` (unit, mocked
 * repository), this exercises the real `PrivateNetworkGuard`, the real
 * `SmsLifecycleRepository.resetForRequeue`, and the real HTTP status codes together.
 */
describe('DlqController (integration, live PostgreSQL over HTTP)', () => {
  let app: INestApplication;
  let http: AxiosInstance;
  let prisma: PrismaService;
  let persistence: SmsPersistenceRepository;
  let lifecycle: SmsLifecycleRepository;
  const createdMessageIds: string[] = [];

  async function createFatalFailureMessage(): Promise<string> {
    const encryption = app.get(EncryptionService);
    const result = await persistence.createOrGetMessage({
      idempotencyKey: `dlq-int-${Date.now()}-${randomUUID()}`,
      recipientPhone: '+14155552671',
      encryptedMessage: encryption.encrypt('DLQ controller integration test body'),
      metadata: { source: 'dlq-controller-integration-test' },
    });
    createdMessageIds.push(result.message.id);

    await lifecycle.beginProcessing(result.message.id);
    await lifecycle.markFatalFailure(result.message.id, 'exhausted for dlq.controller.int-spec');

    return result.message.id;
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

    const server = app.getHttpServer() as Server;
    const address = server.address() as AddressInfo;
    http = axios.create({
      baseURL: `http://127.0.0.1:${address.port}`,
      validateStatus: () => true,
    });

    prisma = app.get(PrismaService);
    persistence = app.get(SmsPersistenceRepository);
    lifecycle = app.get(SmsLifecycleRepository);
  });

  afterAll(async () => {
    if (createdMessageIds.length > 0) {
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: createdMessageIds } } });
      await prisma.smsIdempotencyKey.deleteMany({
        where: { smsMessageId: { in: createdMessageIds } },
      });
      await prisma.smsAttemptResolution.deleteMany({
        where: { smsMessageId: { in: createdMessageIds } },
      });
      await prisma.smsAttempt.deleteMany({ where: { smsMessageId: { in: createdMessageIds } } });
      await prisma.smsMessage.deleteMany({ where: { id: { in: createdMessageIds } } });
    }

    if (app) {
      await app.close();
    }
  });

  it('requeues a FATAL_FAILURE message with 202 and restores a full retry budget', async () => {
    const messageId = await createFatalFailureMessage();

    const response = await http.post(`/internal/dlq/${messageId}/requeue`);

    expect(response.status).toBe(202);
    expect(response.data).toEqual({ messageId, status: 'requeued' });

    const row = await prisma.smsMessage.findUniqueOrThrow({ where: { id: messageId } });
    expect(row.status).toBe('RETRY_SCHEDULED');
    expect(row.retryRounds).toBe(0);
    expect(row.lastError).toBeNull();
  });

  it('is idempotent: a second requeue is rejected with 409 and writes no duplicate audit record', async () => {
    const messageId = await createFatalFailureMessage();

    const first = await http.post(`/internal/dlq/${messageId}/requeue`);
    expect(first.status).toBe(202);

    const second = await http.post(`/internal/dlq/${messageId}/requeue`);
    expect(second.status).toBe(409);

    const requeueEvents = await prisma.outboxEvent.count({
      where: { aggregateId: messageId, eventType: 'SMS_REQUEUED' },
    });
    expect(requeueEvents).toBe(1);
  });

  it('returns 404 for an unknown message id', async () => {
    const response = await http.post(`/internal/dlq/${randomUUID()}/requeue`);

    expect(response.status).toBe(404);
  });
});
