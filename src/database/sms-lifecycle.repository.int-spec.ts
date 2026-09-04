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

  it('leaves an ambiguous failure parked in AWAITING_PROVIDER_RESULT', async () => {
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
    });

    const parked = await client.smsMessage.findUniqueOrThrow({
      where: { id: message.message.id },
    });
    expect(parked.status).toBe('AWAITING_PROVIDER_RESULT');

    const attempt = await client.smsAttempt.findUniqueOrThrow({
      where: { id: reservation.attemptId },
    });
    expect(attempt.isAmbiguous).toBe(true);
  });
});
