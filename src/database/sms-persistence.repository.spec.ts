import {
  IdempotencyOwner,
  PersistedSmsMessage,
  SmsPersistenceClient,
  SmsPersistenceRepository,
  SmsPersistenceTransaction,
} from './sms-persistence.repository';

const now = new Date('2026-09-04T12:00:00.000Z');
const message: PersistedSmsMessage = {
  id: '77b9aa41-4ba3-4785-b593-7d0265416cde',
  idempotencyKey: 'request-123',
  recipientPhone: '+14155552671',
  encryptedMessage: 'ciphertext-only',
  metadata: { purpose: 'OTP' },
  status: 'QUEUED',
  selectedProvider: null,
  providerMessageId: null,
  lastError: null,
  deliveryAttempts: 0,
  retryRounds: 0,
  retentionExpiresAt: new Date('2026-12-03T12:00:00.000Z'),
  createdAt: now,
  updatedAt: now,
};

function createPrismaMock(existingOwner: IdempotencyOwner | null = null) {
  const transaction = {
    smsIdempotencyKey: {
      findUnique: jest.fn(() => Promise.resolve(existingOwner)),
      deleteMany: jest.fn(() => Promise.resolve({ count: existingOwner ? 1 : 0 })),
      create: jest.fn(() => Promise.resolve({ key: 'request-123', smsMessageId: message.id })),
    },
    smsMessage: {
      create: jest.fn(() => Promise.resolve(message)),
    },
    outboxEvent: {
      create: jest.fn(() => Promise.resolve({ id: 'outbox-1' })),
    },
    smsAttempt: {
      create: jest.fn(() => Promise.resolve({ id: 'attempt-1' })),
    },
  } satisfies SmsPersistenceTransaction;

  const client: SmsPersistenceClient = {
    $transaction: async <T>(callback: (client: SmsPersistenceTransaction) => Promise<T>) =>
      callback(transaction),
  };

  return {
    client,
    transaction,
  };
}

describe('SmsPersistenceRepository', () => {
  it('records a timeout as an immutable ambiguous provider attempt', async () => {
    const prisma = createPrismaMock();
    const repository = new SmsPersistenceRepository(prisma.client);

    await repository.recordProviderAttempt({
      smsMessageId: message.id,
      provider: 'twilio',
      outcome: 'TIMEOUT',
      isRetryable: true,
      isAmbiguous: true,
      errorCode: 'REQUEST_TIMEOUT',
      errorMessage: 'Provider request timed out',
    });

    expect(prisma.transaction.smsAttempt.create).toHaveBeenCalledWith({
      data: {
        smsMessageId: message.id,
        provider: 'twilio',
        outcome: 'TIMEOUT',
        isRetryable: true,
        isAmbiguous: true,
        errorCode: 'REQUEST_TIMEOUT',
        errorMessage: 'Provider request timed out',
      },
    });
  });

  it('persists a queued ciphertext-only message, its idempotency ownership, and outbox event atomically', async () => {
    const prisma = createPrismaMock();
    const repository = new SmsPersistenceRepository(prisma.client);

    const result = await repository.createOrGetMessage(
      {
        idempotencyKey: 'request-123',
        recipientPhone: '+14155552671',
        encryptedMessage: 'ciphertext-only',
        metadata: { purpose: 'OTP' },
      },
      now,
    );

    expect(result).toEqual({ created: true, message });
    expect(prisma.transaction.smsMessage.create).toHaveBeenCalledWith({
      data: {
        idempotencyKey: 'request-123',
        recipientPhone: '+14155552671',
        encryptedMessage: 'ciphertext-only',
        metadata: { purpose: 'OTP' },
        status: 'QUEUED',
        deliveryAttempts: 0,
        retryRounds: 0,
        retentionExpiresAt: new Date('2026-12-03T12:00:00.000Z'),
      },
    });
    expect(prisma.transaction.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'SMS_MESSAGE',
        aggregateId: message.id,
        eventType: 'SMS_MESSAGE_QUEUED',
        payload: { messageId: message.id },
      },
    });
    expect(prisma.transaction.smsIdempotencyKey.create).toHaveBeenCalledWith({
      data: {
        key: 'request-123',
        expiresAt: new Date('2026-09-05T12:00:00.000Z'),
        smsMessageId: message.id,
      },
    });
  });

  it('returns the existing message without new writes while the idempotency ownership is active', async () => {
    const prisma = createPrismaMock({
      expiresAt: new Date('2026-09-05T12:00:00.000Z'),
      smsMessage: message,
    });
    const repository = new SmsPersistenceRepository(prisma.client);

    const result = await repository.createOrGetMessage(
      {
        idempotencyKey: 'request-123',
        recipientPhone: '+14155552671',
        encryptedMessage: 'different-ciphertext',
      },
      now,
    );

    expect(result).toEqual({ created: false, message });
    expect(prisma.transaction.smsMessage.create).not.toHaveBeenCalled();
    expect(prisma.transaction.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('releases expired ownership so a new message can retain the same key while the old message remains historical', async () => {
    const prisma = createPrismaMock({
      expiresAt: new Date('2026-09-04T11:59:59.999Z'),
      smsMessage: message,
    });
    const repository = new SmsPersistenceRepository(prisma.client);

    const result = await repository.createOrGetMessage(
      {
        idempotencyKey: 'request-123',
        recipientPhone: '+14155552671',
        encryptedMessage: 'ciphertext-for-new-message',
      },
      now,
    );

    expect(result.created).toBe(true);
    expect(prisma.transaction.smsIdempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: { key: 'request-123', expiresAt: { lte: now } },
    });
    expect(prisma.transaction.smsMessage.create).toHaveBeenCalledTimes(1);
  });

  it('returns the concurrent winner when unique idempotency ownership conflicts', async () => {
    const winner = {
      key: 'request-123',
      expiresAt: new Date('2026-09-05T12:00:00.000Z'),
      smsMessage: message,
    };
    const prisma = createPrismaMock();
    prisma.transaction.smsIdempotencyKey.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue(winner);
    prisma.transaction.smsIdempotencyKey.create.mockRejectedValueOnce({ code: 'P2002' });
    const repository = new SmsPersistenceRepository(prisma.client);

    const result = await repository.createOrGetMessage(
      {
        idempotencyKey: 'request-123',
        recipientPhone: '+14155552671',
        encryptedMessage: 'ciphertext-only',
      },
      now,
    );

    expect(result).toEqual({ created: false, message });
    expect(prisma.transaction.smsIdempotencyKey.findUnique).toHaveBeenCalledTimes(2);
  });
});
