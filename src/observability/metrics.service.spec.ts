import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('returns current queue, outbox, DLQ gauges and process-lifetime delivery counters', async () => {
    const prisma = { outboxEvent: { count: jest.fn().mockResolvedValue(3) } };
    const dispatchQueue = {
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 4, delayed: 2, active: 1 }),
    };
    const deadLetterQueue = {
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 5, delayed: 0, active: 0 }),
    };
    const metrics = new MetricsService(
      prisma as never,
      dispatchQueue as never,
      deadLetterQueue as never,
    );
    metrics.recordProviderAttempt();
    metrics.recordProviderError();
    metrics.recordFailover();
    metrics.recordDeadLetter();
    metrics.recordDeadLetterNotification();
    metrics.recordProcessingLatency(40);
    metrics.recordProcessingLatency(60);

    await expect(metrics.snapshot()).resolves.toEqual({
      gauges: {
        dispatchQueue: { waiting: 4, delayed: 2, active: 1 },
        outboxUnpublished: 3,
        deadLetterQueue: { waiting: 5, delayed: 0, active: 0 },
      },
      counters: {
        providerAttempts: 1,
        providerErrors: 1,
        failovers: 1,
        deadLetters: 1,
        deadLetterNotifications: 1,
        processingLatency: { count: 2, totalMs: 100, averageMs: 50 },
      },
    });
    expect(prisma.outboxEvent.count).toHaveBeenCalledWith({ where: { publishedAt: null } });
  });
});
