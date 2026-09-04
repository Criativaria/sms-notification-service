import { PrismaService } from './prisma.service';
import { type LifecycleSmsMessage, SmsLifecycleRepository } from './sms-lifecycle.repository';
import { type SmsStatus } from './sms-state-machine';

const messageId = 'b0f6f6a4-2f2c-4b7a-9d2e-1f3a4b5c6d7e';

function lifecycle(overrides: Partial<LifecycleSmsMessage> = {}): LifecycleSmsMessage {
  return {
    id: messageId,
    status: 'PROCESSING',
    selectedProvider: null,
    providerMessageId: null,
    lastError: null,
    deliveryAttempts: 0,
    retryRounds: 0,
    createdAt: new Date('2026-09-04T12:00:00.000Z'),
    updatedAt: new Date('2026-09-04T12:00:00.000Z'),
    ...overrides,
  };
}

function createPrismaMock() {
  const smsMessage = {
    updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(() => Promise.resolve({ count: 1 })),
    findUnique: jest.fn<Promise<unknown>, [unknown]>(() => Promise.resolve(lifecycle())),
    findFirst: jest.fn<Promise<unknown>, [unknown]>(() => Promise.resolve(null)),
  };

  const outboxEvent = {
    findMany: jest.fn<Promise<unknown>, [unknown]>(() => Promise.resolve([])),
    update: jest.fn<Promise<unknown>, [unknown]>(() => Promise.resolve({})),
    create: jest.fn<Promise<unknown>, [unknown]>(() => Promise.resolve({ id: 'outbox-1' })),
  };

  const smsAttempt = {
    create: jest.fn<Promise<unknown>, [unknown]>(() => Promise.resolve({ id: 'attempt-1' })),
    updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(() => Promise.resolve({ count: 1 })),
    findUnique: jest.fn<Promise<unknown>, [unknown]>(() =>
      Promise.resolve({ smsMessageId: messageId, provider: 'twilio', isAmbiguous: true }),
    ),
  };
  const smsAttemptResolution = {
    create: jest.fn<Promise<unknown>, [unknown]>(() => Promise.resolve({ id: 'resolution-1' })),
    findUnique: jest.fn<Promise<unknown>, [unknown]>(() => Promise.resolve(null)),
  };

  const prisma = {
    smsMessage,
    outboxEvent,
    $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
      callback({ smsMessage, outboxEvent, smsAttempt, smsAttemptResolution }),
    ),
  };

  return {
    prisma: prisma as unknown as PrismaService,
    smsMessage,
    outboxEvent,
    smsAttempt,
    smsAttemptResolution,
  };
}

describe('SmsLifecycleRepository', () => {
  describe('outbox relay', () => {
    it('fetches unpublished events oldest-first up to the limit', async () => {
      const mock = createPrismaMock();
      const repository = new SmsLifecycleRepository(mock.prisma);

      await repository.fetchUnpublishedOutbox(50);

      expect(mock.outboxEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { publishedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 50,
        }),
      );
    });

    it('marks an outbox event published with a timestamp', async () => {
      const mock = createPrismaMock();
      const repository = new SmsLifecycleRepository(mock.prisma);
      const now = new Date('2026-09-04T12:30:00.000Z');

      await repository.markOutboxPublished('outbox-1', now);

      expect(mock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: 'outbox-1' },
        data: { publishedAt: now },
      });
    });

    it('increments retry count and records the last error on publish failure', async () => {
      const mock = createPrismaMock();
      const repository = new SmsLifecycleRepository(mock.prisma);

      await repository.recordOutboxPublishFailure('outbox-1', 'broker unavailable');

      expect(mock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: 'outbox-1' },
        data: { retryCount: { increment: 1 }, lastError: 'broker unavailable' },
      });
    });
  });

  describe('beginProcessing', () => {
    it('claims a startable message and returns it', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.updateMany.mockResolvedValueOnce({ count: 1 });
      mock.smsMessage.findUnique.mockResolvedValueOnce(lifecycle({ status: 'PROCESSING' }));
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.beginProcessing(messageId);

      expect(result).toEqual({ outcome: 'started', message: lifecycle({ status: 'PROCESSING' }) });
      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: {
          id: messageId,
          status: { in: ['QUEUED', 'RETRY_SCHEDULED'] },
        },
        data: { status: 'PROCESSING' },
      });
    });

    it('returns not_startable when the row was already claimed', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.updateMany.mockResolvedValueOnce({ count: 0 });
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.beginProcessing(messageId);

      expect(result).toEqual({ outcome: 'not_startable' });
      expect(mock.smsMessage.findUnique).not.toHaveBeenCalled();
    });

    it('never claims a message that is AWAITING_PROVIDER_RESULT, even though that status is a structural predecessor of PROCESSING', async () => {
      // Regression guard: AWAITING_PROVIDER_RESULT -> PROCESSING is a legal transition in
      // sms-state-machine.ts (the internal release performed by finalizeProviderAttempt), so
      // it would appear in sourceStatesOf('PROCESSING'). beginProcessing must use its own
      // narrower, explicit source list instead of that raw lookup, or a message holding an
      // outstanding provider reservation could be re-claimed as a fresh job and dispatched
      // to a provider a second time.
      const mock = createPrismaMock();
      const repository = new SmsLifecycleRepository(mock.prisma);

      await repository.beginProcessing(messageId);

      const call = mock.smsMessage.updateMany.mock.calls[0]?.[0] as {
        where: { status: { in: string[] } };
      };
      expect(call.where.status.in).not.toContain('AWAITING_PROVIDER_RESULT');
      expect(call.where.status.in).toEqual(['QUEUED', 'RETRY_SCHEDULED']);
    });
  });

  describe('reserveProviderAttempt', () => {
    it('atomically reserves a provider attempt and moves PROCESSING out of dispatchability', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.updateMany.mockResolvedValueOnce({ count: 1 });
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.reserveProviderAttempt(messageId, 'twilio');

      expect(result).toEqual({ outcome: 'reserved', attemptId: 'attempt-1' });
      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: { id: messageId, status: 'PROCESSING' },
        data: {
          status: 'AWAITING_PROVIDER_RESULT',
          selectedProvider: 'twilio',
          deliveryAttempts: { increment: 1 },
        },
      });
      expect(mock.smsAttempt.create).toHaveBeenCalledWith({
        data: {
          smsMessageId: messageId,
          provider: 'twilio',
          outcome: 'RESERVED',
          isRetryable: false,
          isAmbiguous: true,
        },
      });
    });

    it('reserves a second provider (e.g. bird) by name after a released reservation', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.updateMany.mockResolvedValueOnce({ count: 1 });
      const repository = new SmsLifecycleRepository(mock.prisma);

      await repository.reserveProviderAttempt(messageId, 'bird');

      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: { id: messageId, status: 'PROCESSING' },
        data: {
          status: 'AWAITING_PROVIDER_RESULT',
          selectedProvider: 'bird',
          deliveryAttempts: { increment: 1 },
        },
      });
      expect(mock.smsAttempt.create).toHaveBeenCalledWith({
        data: {
          smsMessageId: messageId,
          provider: 'bird',
          outcome: 'RESERVED',
          isRetryable: false,
          isAmbiguous: true,
        },
      });
    });
  });

  describe('finalizeProviderAttempt', () => {
    it('atomically finalizes the reservation and marks an accepted delivery as SENT', async () => {
      const mock = createPrismaMock();
      mock.smsAttempt.updateMany.mockResolvedValueOnce({ count: 1 });
      mock.smsMessage.updateMany.mockResolvedValueOnce({ count: 1 });
      const repository = new SmsLifecycleRepository(mock.prisma);

      await repository.finalizeProviderAttempt(messageId, 'attempt-1', {
        outcome: 'ACCEPTED',
        providerMessageId: 'twilio-message-1',
      });

      expect(mock.smsAttempt.updateMany).toHaveBeenCalledWith({
        where: { id: 'attempt-1', smsMessageId: messageId, outcome: 'RESERVED' },
        data: {
          outcome: 'ACCEPTED',
          isRetryable: false,
          isAmbiguous: false,
          providerMessageId: 'twilio-message-1',
        },
      });
      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: { id: messageId, status: 'AWAITING_PROVIDER_RESULT' },
        data: { status: 'SENT', providerMessageId: 'twilio-message-1' },
      });
    });

    it('releases a definitive (non-ambiguous) failure back to PROCESSING', async () => {
      const mock = createPrismaMock();
      mock.smsAttempt.updateMany.mockResolvedValueOnce({ count: 1 });
      mock.smsMessage.updateMany.mockResolvedValueOnce({ count: 1 });
      const repository = new SmsLifecycleRepository(mock.prisma);

      await repository.finalizeProviderAttempt(messageId, 'attempt-1', {
        outcome: 'FAILED',
        isAmbiguous: false,
        isRetryable: true,
        errorMessage: '[http] twilio responded with status 503',
      });

      expect(mock.smsAttempt.updateMany).toHaveBeenCalledWith({
        where: { id: 'attempt-1', smsMessageId: messageId, outcome: 'RESERVED' },
        data: {
          outcome: 'FAILED',
          isRetryable: true,
          isAmbiguous: false,
          errorMessage: '[http] twilio responded with status 503',
        },
      });
      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: { id: messageId, status: 'AWAITING_PROVIDER_RESULT' },
        data: { status: 'PROCESSING' },
      });
    });

    it('leaves an ambiguous failure parked in AWAITING_PROVIDER_RESULT (no status update)', async () => {
      const mock = createPrismaMock();
      mock.smsAttempt.updateMany.mockResolvedValueOnce({ count: 1 });
      const repository = new SmsLifecycleRepository(mock.prisma);

      await repository.finalizeProviderAttempt(messageId, 'attempt-1', {
        outcome: 'FAILED',
        isAmbiguous: true,
        isRetryable: true,
        errorMessage: '[timeout] twilio request timed out',
      });

      expect(mock.smsAttempt.updateMany).toHaveBeenCalledWith({
        where: { id: 'attempt-1', smsMessageId: messageId, outcome: 'RESERVED' },
        data: {
          outcome: 'FAILED',
          isRetryable: true,
          isAmbiguous: true,
          errorMessage: '[timeout] twilio request timed out',
        },
      });
      expect(mock.smsMessage.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('resolveTwilioAttempt', () => {
    it('atomically resolves an ambiguous Twilio attempt to SENT and appends an audit record', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findUnique
        .mockResolvedValueOnce({ status: 'AWAITING_PROVIDER_RESULT' as SmsStatus })
        .mockResolvedValueOnce(
          lifecycle({ status: 'SENT', providerMessageId: 'SM1234567890abcdef1234567890abcdef' }),
        );
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.resolveTwilioAttempt(messageId, 'attempt-1', {
        resolution: 'KNOWN_SID',
        providerMessageId: 'SM1234567890abcdef1234567890abcdef',
      });

      expect(result).toEqual({
        outcome: 'resolved',
        message: lifecycle({
          status: 'SENT',
          providerMessageId: 'SM1234567890abcdef1234567890abcdef',
        }),
      });
      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: { id: messageId, status: 'AWAITING_PROVIDER_RESULT' },
        data: { status: 'SENT', providerMessageId: 'SM1234567890abcdef1234567890abcdef' },
      });
      expect(mock.smsAttemptResolution.create).toHaveBeenCalledWith({
        data: {
          smsMessageId: messageId,
          smsAttemptId: 'attempt-1',
          resolution: 'KNOWN_SID',
          providerMessageId: 'SM1234567890abcdef1234567890abcdef',
          evidenceCode: null,
        },
      });
    });

    it('returns an idempotent result for an identical existing resolution', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findUnique.mockResolvedValueOnce({ status: 'SENT' as SmsStatus });
      mock.smsAttemptResolution.findUnique.mockResolvedValueOnce({
        resolution: 'KNOWN_SID',
        providerMessageId: 'SM1234567890abcdef1234567890abcdef',
        evidenceCode: null,
      });
      mock.smsMessage.findUnique.mockResolvedValueOnce(
        lifecycle({ status: 'SENT', providerMessageId: 'SM1234567890abcdef1234567890abcdef' }),
      );
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.resolveTwilioAttempt(messageId, 'attempt-1', {
        resolution: 'KNOWN_SID',
        providerMessageId: 'SM1234567890abcdef1234567890abcdef',
      });

      expect(result.outcome).toBe('already_resolved');
      expect(mock.smsMessage.updateMany).not.toHaveBeenCalled();
      expect(mock.smsAttemptResolution.create).not.toHaveBeenCalled();
    });

    it('returns a conflict for a different repeat resolution', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findUnique.mockResolvedValueOnce({ status: 'SENT' as SmsStatus });
      mock.smsAttemptResolution.findUnique.mockResolvedValueOnce({
        resolution: 'KNOWN_SID',
        providerMessageId: 'SM1234567890abcdef1234567890abcdef',
        evidenceCode: null,
      });
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.resolveTwilioAttempt(messageId, 'attempt-1', {
        resolution: 'UNDELIVERED',
        evidenceCode: 'TWILIO_UNDELIVERED_CONFIRMED',
      });

      expect(result).toEqual({ outcome: 'conflict' });
      expect(mock.smsMessage.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('scheduleRetry', () => {
    it('atomically persists PROCESSING -> RETRY_SCHEDULED and its retry outbox intent', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findUnique
        .mockResolvedValueOnce({ status: 'PROCESSING' as SmsStatus })
        .mockResolvedValueOnce(lifecycle({ status: 'RETRY_SCHEDULED', retryRounds: 1 }));
      const repository = new SmsLifecycleRepository(mock.prisma);

      await repository.scheduleRetry(messageId, {
        incrementRound: true,
        delayMs: 2000,
        lastError: 'timeout',
      });

      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: { id: messageId, status: 'PROCESSING' },
        data: {
          deliveryAttempts: { increment: 1 },
          retryRounds: { increment: 1 },
          lastError: 'timeout',
          status: 'RETRY_SCHEDULED',
        },
      });
      expect(mock.outboxEvent.create).toHaveBeenCalledWith({
        data: {
          aggregateType: 'SMS_MESSAGE',
          aggregateId: messageId,
          eventType: 'SMS_RETRY_SCHEDULED',
          payload: { messageId, delayMs: 2000 },
        },
      });
    });

    it('increments the retry round when asked', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findUnique
        .mockResolvedValueOnce({ status: 'PROCESSING' as SmsStatus })
        .mockResolvedValueOnce(lifecycle({ status: 'RETRY_SCHEDULED' }));
      const repository = new SmsLifecycleRepository(mock.prisma);

      await repository.scheduleRetry(messageId, {
        incrementRound: true,
        delayMs: 2000,
        lastError: 'timeout',
      });

      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: { id: messageId, status: 'PROCESSING' },
        data: {
          deliveryAttempts: { increment: 1 },
          retryRounds: { increment: 1 },
          lastError: 'timeout',
          status: 'RETRY_SCHEDULED',
        },
      });
    });

    it('keeps the retry round when incrementRound is false and no error is given', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findUnique
        .mockResolvedValueOnce({ status: 'PROCESSING' as SmsStatus })
        .mockResolvedValueOnce(lifecycle({ status: 'RETRY_SCHEDULED' }));
      const repository = new SmsLifecycleRepository(mock.prisma);

      await repository.scheduleRetry(messageId, { incrementRound: false, delayMs: 2000 });

      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: { id: messageId, status: 'PROCESSING' },
        data: { deliveryAttempts: { increment: 1 }, status: 'RETRY_SCHEDULED' },
      });
    });
  });

  describe('markPermanentProviderFailure', () => {
    it('guards PROCESSING -> REJECTED and records the error', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findUnique
        .mockResolvedValueOnce({ status: 'PROCESSING' as SmsStatus })
        .mockResolvedValueOnce(lifecycle({ status: 'REJECTED', lastError: 'blocked' }));
      const repository = new SmsLifecycleRepository(mock.prisma);

      const message = await repository.markPermanentProviderFailure(
        messageId,
        'REJECTED',
        'blocked',
      );

      expect(message.status).toBe('REJECTED');
      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: { id: messageId, status: 'PROCESSING' },
        data: { lastError: 'blocked', status: 'REJECTED' },
      });
    });
  });

  describe('markFatalFailure', () => {
    it('atomically persists PROCESSING -> FATAL_FAILURE and its DLQ outbox intent', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findUnique
        .mockResolvedValueOnce({ status: 'PROCESSING' as SmsStatus })
        .mockResolvedValueOnce(lifecycle({ status: 'FATAL_FAILURE', lastError: 'exhausted' }));
      const repository = new SmsLifecycleRepository(mock.prisma);

      const message = await repository.markFatalFailure(messageId, 'exhausted');

      expect(message.status).toBe('FATAL_FAILURE');
      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: { id: messageId, status: 'PROCESSING' },
        data: { lastError: 'exhausted', status: 'FATAL_FAILURE' },
      });
      expect(mock.outboxEvent.create).toHaveBeenCalledWith({
        data: {
          aggregateType: 'SMS_MESSAGE',
          aggregateId: messageId,
          eventType: 'SMS_DEAD_LETTERED',
          payload: { messageId },
        },
      });
    });
  });

  describe('resetForRequeue', () => {
    it('atomically resets FATAL_FAILURE to RETRY_SCHEDULED and persists a requeue outbox intent', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findUnique
        .mockResolvedValueOnce({ status: 'FATAL_FAILURE' as SmsStatus })
        .mockResolvedValueOnce(lifecycle({ status: 'RETRY_SCHEDULED' }));
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.resetForRequeue(messageId);

      expect(result).toEqual({
        outcome: 'requeued',
        message: lifecycle({ status: 'RETRY_SCHEDULED' }),
      });
      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: { id: messageId, status: 'FATAL_FAILURE' },
        data: { status: 'RETRY_SCHEDULED', retryRounds: 0, lastError: null },
      });
      expect(mock.outboxEvent.create).toHaveBeenCalledWith({
        data: {
          aggregateType: 'SMS_MESSAGE',
          aggregateId: messageId,
          eventType: 'SMS_REQUEUED',
          payload: { messageId },
        },
      });
    });

    it('returns not_found when the message does not exist', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findUnique.mockResolvedValueOnce(null);
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.resetForRequeue(messageId);

      expect(result).toEqual({ outcome: 'not_found' });
      expect(mock.smsMessage.updateMany).not.toHaveBeenCalled();
    });

    it('returns not_fatal without writing when the message is not in FATAL_FAILURE', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findUnique.mockResolvedValueOnce({ status: 'SENT' as SmsStatus });
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.resetForRequeue(messageId);

      expect(result).toEqual({ outcome: 'not_fatal', currentStatus: 'SENT' });
      expect(mock.smsMessage.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('applyDeliveryReport', () => {
    it('returns not_found when no message matches the provider message id', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findFirst.mockResolvedValueOnce(null);
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.applyDeliveryReport({
        providerMessageId: 'missing',
        terminalStatus: 'DELIVERED',
      });

      expect(result).toEqual({ outcome: 'not_found' });
      expect(mock.smsMessage.updateMany).not.toHaveBeenCalled();
    });

    it('returns duplicate without writing when already in the requested terminal status', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findFirst.mockResolvedValueOnce({ id: messageId, status: 'DELIVERED' });
      mock.smsMessage.findUnique.mockResolvedValueOnce(lifecycle({ status: 'DELIVERED' }));
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.applyDeliveryReport({
        providerMessageId: 'provider-msg-1',
        terminalStatus: 'DELIVERED',
      });

      expect(result).toEqual({ outcome: 'duplicate', message: lifecycle({ status: 'DELIVERED' }) });
      expect(mock.smsMessage.updateMany).not.toHaveBeenCalled();
    });

    it('applies SENT -> DELIVERED and returns applied', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findFirst.mockResolvedValueOnce({ id: messageId, status: 'SENT' });
      mock.smsMessage.updateMany.mockResolvedValueOnce({ count: 1 });
      mock.smsMessage.findUnique.mockResolvedValueOnce(lifecycle({ status: 'DELIVERED' }));
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.applyDeliveryReport({
        providerMessageId: 'provider-msg-1',
        terminalStatus: 'DELIVERED',
      });

      expect(result).toEqual({ outcome: 'applied', message: lifecycle({ status: 'DELIVERED' }) });
      expect(mock.smsMessage.updateMany).toHaveBeenCalledWith({
        where: { id: messageId, status: 'SENT' },
        data: { status: 'DELIVERED' },
      });
    });

    it('returns invalid_transition without writing when the current status cannot reach the target', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findFirst.mockResolvedValueOnce({ id: messageId, status: 'QUEUED' });
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.applyDeliveryReport({
        providerMessageId: 'provider-msg-1',
        terminalStatus: 'DELIVERED',
      });

      expect(result).toEqual({ outcome: 'invalid_transition', currentStatus: 'QUEUED' });
      expect(mock.smsMessage.updateMany).not.toHaveBeenCalled();
    });

    it('returns invalid_transition when the guarded update loses the race', async () => {
      const mock = createPrismaMock();
      mock.smsMessage.findFirst.mockResolvedValueOnce({ id: messageId, status: 'SENT' });
      mock.smsMessage.updateMany.mockResolvedValueOnce({ count: 0 });
      const repository = new SmsLifecycleRepository(mock.prisma);

      const result = await repository.applyDeliveryReport({
        providerMessageId: 'provider-msg-1',
        terminalStatus: 'DELIVERED',
      });

      expect(result).toEqual({ outcome: 'invalid_transition', currentStatus: 'SENT' });
    });
  });
});
