import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../database/prisma.service';
import { retentionMetrics } from './retention.metrics';
import { RetentionService } from './retention.service';

interface TxMocks {
  smsMessage: { findMany: jest.Mock; deleteMany: jest.Mock };
  smsAttempt: { deleteMany: jest.Mock };
  outboxEvent: { deleteMany: jest.Mock };
}

interface Mocks {
  tx: TxMocks;
  prisma: { $transaction: jest.Mock };
  config: { get: jest.Mock };
}

function buildMocks(): Mocks {
  const tx: TxMocks = {
    smsMessage: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    smsAttempt: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    outboxEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };

  return {
    tx,
    // Invoke the callback with the mocked transaction client, mirroring Prisma's
    // interactive-transaction contract.
    prisma: { $transaction: jest.fn((cb: (t: TxMocks) => unknown) => cb(tx)) },
    config: { get: jest.fn().mockReturnValue(undefined) },
  };
}

function buildService(mocks: Mocks): RetentionService {
  return new RetentionService(
    mocks.prisma as unknown as PrismaService,
    mocks.config as unknown as ConfigService,
  );
}

describe('RetentionService', () => {
  beforeEach(() => {
    retentionMetrics.retentionDeletedTotal = 0;
  });

  it('selects only expired terminal messages, deletes children before messages in a transaction, and returns the count', async () => {
    const mocks = buildMocks();
    mocks.tx.smsMessage.findMany.mockResolvedValue([{ id: 'msg-1' }, { id: 'msg-2' }]);
    mocks.tx.smsMessage.deleteMany.mockResolvedValue({ count: 2 });
    const service = buildService(mocks);
    const now = new Date('2026-09-04T00:00:00.000Z');

    const result = await service.purgeExpired(now);

    expect(result).toEqual({ deletedMessages: 2 });
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);

    // Query scopes to expired retention window AND terminal statuses only, capped by batch size.
    expect(mocks.tx.smsMessage.findMany).toHaveBeenCalledWith({
      where: {
        retentionExpiresAt: { lte: now },
        status: { in: ['DELIVERED', 'UNDELIVERED', 'REJECTED', 'FATAL_FAILURE'] },
      },
      select: { id: true },
      take: 500,
    });

    // Children deleted before the messages (Restrict FKs), keyed by the selected ids.
    expect(mocks.tx.smsAttempt.deleteMany).toHaveBeenCalledWith({
      where: { smsMessageId: { in: ['msg-1', 'msg-2'] } },
    });
    expect(mocks.tx.outboxEvent.deleteMany).toHaveBeenCalledWith({
      where: { aggregateId: { in: ['msg-1', 'msg-2'] } },
    });
    expect(mocks.tx.smsMessage.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['msg-1', 'msg-2'] } },
    });

    const attemptOrder = mocks.tx.smsAttempt.deleteMany.mock.invocationCallOrder[0]!;
    const outboxOrder = mocks.tx.outboxEvent.deleteMany.mock.invocationCallOrder[0]!;
    const messageOrder = mocks.tx.smsMessage.deleteMany.mock.invocationCallOrder[0]!;
    expect(attemptOrder).toBeLessThan(messageOrder);
    expect(outboxOrder).toBeLessThan(messageOrder);
  });

  it('increments the retention metric by the deleted count', async () => {
    const mocks = buildMocks();
    mocks.tx.smsMessage.findMany.mockResolvedValue([
      { id: 'msg-1' },
      { id: 'msg-2' },
      { id: 'msg-3' },
    ]);
    mocks.tx.smsMessage.deleteMany.mockResolvedValue({ count: 3 });
    const service = buildService(mocks);

    await service.purgeExpired();

    expect(retentionMetrics.retentionDeletedTotal).toBe(3);
  });

  it('deletes nothing and reports zero when no messages are expired', async () => {
    const mocks = buildMocks();
    const service = buildService(mocks);

    const result = await service.purgeExpired();

    expect(result).toEqual({ deletedMessages: 0 });
    expect(mocks.tx.smsAttempt.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.outboxEvent.deleteMany).not.toHaveBeenCalled();
    expect(mocks.tx.smsMessage.deleteMany).not.toHaveBeenCalled();
    expect(retentionMetrics.retentionDeletedTotal).toBe(0);
  });

  it('honors a configured batch size when selecting a batch', async () => {
    const mocks = buildMocks();
    mocks.config.get.mockImplementation((key: string) =>
      key === 'RETENTION_CLEANUP_BATCH_SIZE' ? 50 : undefined,
    );
    const service = buildService(mocks);

    await service.purgeExpired();

    expect(mocks.tx.smsMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });
});
