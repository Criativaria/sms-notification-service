import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { SmsLifecycleRepository } from '../../database/sms-lifecycle.repository';
import { ProcessingRecoveryService } from './processing-recovery.service';

describe('ProcessingRecoveryService', () => {
  it('registers a durable scheduler and recovers stale PROCESSING messages using the configured timeout and batch size', async () => {
    const lifecycle = { recoverStaleProcessing: jest.fn().mockResolvedValue({ recovered: 2 }) };
    const queue = { upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };
    const config = new ConfigService({
      PROCESSING_RECOVERY_INTERVAL_MS: 30_000,
      PROCESSING_STALE_AFTER_MS: 120_000,
      PROCESSING_RECOVERY_BATCH_SIZE: 25,
    });
    const service = new ProcessingRecoveryService(
      lifecycle as unknown as SmsLifecycleRepository,
      config,
      queue as unknown as Queue,
    );
    const before = Date.now();

    await service.onModuleInit();
    const result = await service.recoverStaleProcessing();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'processing-recovery',
      { every: 30_000 },
      { name: 'processing-recovery', data: {} },
    );
    expect(lifecycle.recoverStaleProcessing).toHaveBeenCalledWith(expect.any(Date), 25);
    const [cutoff] = lifecycle.recoverStaleProcessing.mock.calls[0] as [Date, number];
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 120_000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - 120_000);
    expect(result).toEqual({ recovered: 2 });
  });
});
