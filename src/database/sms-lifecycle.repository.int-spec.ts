import { randomUUID } from 'node:crypto';

import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';
import { SmsLifecycleRepository } from './sms-lifecycle.repository';
import { SmsPersistenceRepository } from './sms-persistence.repository';

describe('SmsLifecycleRepository (integration, live PostgreSQL)', () => {
  let prisma: PrismaService;
  let lifecycle: SmsLifecycleRepository;
  let persistence: SmsPersistenceRepository;
  const createdMessageIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    lifecycle = new SmsLifecycleRepository(prisma);
    persistence = new SmsPersistenceRepository(
      prisma as unknown as ConstructorParameters<typeof SmsPersistenceRepository>[0],
    );
  });

  afterAll(async () => {
    if (createdMessageIds.length > 0) {
      const client = prisma as unknown as PrismaClient;
      await client.outboxEvent.deleteMany({ where: { aggregateId: { in: createdMessageIds } } });
      await client.smsIdempotencyKey.deleteMany({
        where: { smsMessageId: { in: createdMessageIds } },
      });
      await client.smsAttempt.deleteMany({ where: { smsMessageId: { in: createdMessageIds } } });
      await client.smsMessage.deleteMany({ where: { id: { in: createdMessageIds } } });
    }
    await prisma.$disconnect();
  });

  it('durably reserves a provider attempt before finalizing its accepted result', async () => {
    const message = await persistence.createOrGetMessage({
      idempotencyKey: `attempt-${randomUUID()}`,
      recipientPhone: '+14155552671',
      encryptedMessage: 'encrypted-payload',
    });
    createdMessageIds.push(message.message.id);
    const client = prisma as unknown as PrismaClient;

    await lifecycle.beginProcessing(message.message.id);
    const reservation = await lifecycle.reserveProviderAttempt(message.message.id, 'twilio');

    expect(reservation.outcome).toBe('reserved');
    if (reservation.outcome !== 'reserved') {
      return;
    }

    const reserved = await client.smsMessage.findUniqueOrThrow({
      where: { id: message.message.id },
    });
    const attempt = await client.smsAttempt.findUniqueOrThrow({
      where: { id: reservation.attemptId },
    });
    expect(reserved.status).toBe('AWAITING_PROVIDER_RESULT');
    expect(attempt.outcome).toBe('RESERVED');

    await lifecycle.finalizeProviderAttempt(message.message.id, reservation.attemptId, {
      outcome: 'ACCEPTED',
      providerMessageId: 'twilio-message-1',
    });

    const finalized = await client.smsMessage.findUniqueOrThrow({
      where: { id: message.message.id },
    });
    expect(finalized.status).toBe('SENT');
    expect(finalized.providerMessageId).toBe('twilio-message-1');
  });

  it('releases a definitive failure back to PROCESSING so the worker can try the next provider', async () => {
    const message = await persistence.createOrGetMessage({
      idempotencyKey: `attempt-${randomUUID()}`,
      recipientPhone: '+14155552671',
      encryptedMessage: 'encrypted-payload',
    });
    createdMessageIds.push(message.message.id);
    const client = prisma as unknown as PrismaClient;

    await lifecycle.beginProcessing(message.message.id);
    const reservation = await lifecycle.reserveProviderAttempt(message.message.id, 'twilio');
    if (reservation.outcome !== 'reserved') {
      throw new Error('expected reservation');
    }

    await lifecycle.finalizeProviderAttempt(message.message.id, reservation.attemptId, {
      outcome: 'FAILED',
      isAmbiguous: false,
      isRetryable: true,
      errorMessage: '[http] twilio responded with status 503',
    });

    const released = await client.smsMessage.findUniqueOrThrow({
      where: { id: message.message.id },
    });
    expect(released.status).toBe('PROCESSING');

    const attempt = await client.smsAttempt.findUniqueOrThrow({
      where: { id: reservation.attemptId },
    });
    expect(attempt.outcome).toBe('FAILED');
    expect(attempt.isAmbiguous).toBe(false);
    expect(attempt.isRetryable).toBe(true);
  });

  it('commits an expiry outbox event with an ambiguous failure', async () => {
    const message = await persistence.createOrGetMessage({
      idempotencyKey: `attempt-${randomUUID()}`,
      recipientPhone: '+14155552671',
      encryptedMessage: 'encrypted-payload',
    });
    createdMessageIds.push(message.message.id);
    const client = prisma as unknown as PrismaClient;

    await lifecycle.beginProcessing(message.message.id);
    const reservation = await lifecycle.reserveProviderAttempt(message.message.id, 'twilio');
    if (reservation.outcome !== 'reserved') {
      throw new Error('expected reservation');
    }

    await lifecycle.finalizeProviderAttempt(message.message.id, reservation.attemptId, {
      outcome: 'FAILED',
      isAmbiguous: true,
      isRetryable: true,
      errorMessage: '[timeout] twilio request timed out',
      ambiguousOutcomeExpiryMs: 900_000,
    });

    const parked = await client.smsMessage.findUniqueOrThrow({
      where: { id: message.message.id },
    });
    expect(parked.status).toBe('AWAITING_PROVIDER_RESULT');

    const attempt = await client.smsAttempt.findUniqueOrThrow({
      where: { id: reservation.attemptId },
    });
    expect(attempt.isAmbiguous).toBe(true);
    await expect(
      client.outboxEvent.findFirst({
        where: {
          aggregateId: message.message.id,
          eventType: 'SMS_AMBIGUOUS_OUTCOME_EXPIRY_SCHEDULED',
        },
      }),
    ).resolves.toMatchObject({ payload: { messageId: message.message.id, delayMs: 900_000 } });
  });

  it('leaves an expiry job harmless after a delivery report wins the race', async () => {
    const message = await persistence.createOrGetMessage({
      idempotencyKey: `expiry-webhook-${randomUUID()}`,
      recipientPhone: '+14155552671',
      encryptedMessage: 'encrypted-payload',
    });
    createdMessageIds.push(message.message.id);
    const client = prisma as unknown as PrismaClient;
    const providerMessageId = `twilio-webhook-${randomUUID()}`;

    await client.smsMessage.update({
      where: { id: message.message.id },
      data: { status: 'AWAITING_PROVIDER_RESULT', providerMessageId },
    });
    await expect(
      lifecycle.applyDeliveryReport({ providerMessageId, terminalStatus: 'DELIVERED' }),
    ).resolves.toMatchObject({ outcome: 'applied' });
    await expect(lifecycle.expireAmbiguousOutcome(message.message.id)).resolves.toEqual({
      outcome: 'not_awaiting_provider_result',
    });
    await expect(
      client.smsMessage.findUniqueOrThrow({ where: { id: message.message.id } }),
    ).resolves.toMatchObject({ status: 'DELIVERED' });
  });

  it('finalizes an unresolved ambiguous outcome as UNDELIVERED without creating dispatch work', async () => {
    const message = await persistence.createOrGetMessage({
      idempotencyKey: `expiry-${randomUUID()}`,
      recipientPhone: '+14155552671',
      encryptedMessage: 'encrypted-payload',
    });
    createdMessageIds.push(message.message.id);
    const client = prisma as unknown as PrismaClient;

    await client.smsMessage.update({
      where: { id: message.message.id },
      data: { status: 'AWAITING_PROVIDER_RESULT' },
    });
    await expect(lifecycle.expireAmbiguousOutcome(message.message.id)).resolves.toEqual({
      outcome: 'expired',
    });
    await expect(
      client.smsMessage.findUniqueOrThrow({ where: { id: message.message.id } }),
    ).resolves.toMatchObject({ status: 'UNDELIVERED', lastError: 'AMBIGUOUS_OUTCOME_EXPIRED' });
    await expect(
      client.outboxEvent.count({ where: { aggregateId: message.message.id } }),
    ).resolves.toBe(1);
  });

  it('recovers only stale PROCESSING rows without changing counters or touching AWAITING_PROVIDER_RESULT', async () => {
    const recoverable = await persistence.createOrGetMessage({
      idempotencyKey: `recovery-${randomUUID()}`,
      recipientPhone: '+14155552671',
      encryptedMessage: 'encrypted-payload',
    });
    const awaiting = await persistence.createOrGetMessage({
      idempotencyKey: `awaiting-${randomUUID()}`,
      recipientPhone: '+14155552671',
      encryptedMessage: 'encrypted-payload',
    });
    createdMessageIds.push(recoverable.message.id, awaiting.message.id);
    const client = prisma as unknown as PrismaClient;
    const staleAt = new Date('2026-09-04T10:00:00.000Z');
    const cutoff = new Date('2026-09-04T11:00:00.000Z');

    await client.smsMessage.update({
      where: { id: recoverable.message.id },
      data: { status: 'PROCESSING', updatedAt: staleAt },
    });
    await client.smsMessage.update({
      where: { id: awaiting.message.id },
      data: { status: 'AWAITING_PROVIDER_RESULT', updatedAt: staleAt },
    });

    await expect(lifecycle.recoverStaleProcessing(cutoff, 10)).resolves.toEqual({ recovered: 1 });

    await expect(
      client.smsMessage.findUniqueOrThrow({ where: { id: recoverable.message.id } }),
    ).resolves.toMatchObject({
      status: 'RETRY_SCHEDULED',
      deliveryAttempts: 0,
      retryRounds: 0,
    });
    await expect(
      client.smsMessage.findUniqueOrThrow({ where: { id: awaiting.message.id } }),
    ).resolves.toMatchObject({
      status: 'AWAITING_PROVIDER_RESULT',
    });
    await expect(
      client.outboxEvent.count({
        where: { aggregateId: recoverable.message.id, eventType: 'SMS_PROCESSING_RECOVERED' },
      }),
    ).resolves.toBe(1);
  });
});
