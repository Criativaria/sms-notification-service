import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { SmsLifecycleRepository } from '../../database/sms-lifecycle.repository';
import { PROCESSING_RECOVERY_JOB, SMS_MAINTENANCE_QUEUE } from '../queue/queue.constants';

@Injectable()
export class ProcessingRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(ProcessingRecoveryService.name);
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly lifecycle: SmsLifecycleRepository,
    configService: ConfigService,
    @InjectQueue(SMS_MAINTENANCE_QUEUE) private readonly maintenanceQueue: Queue,
  ) {
    this.intervalMs = readPositiveInt(configService.get('PROCESSING_RECOVERY_INTERVAL_MS'), 60_000);
    this.staleAfterMs = readPositiveInt(configService.get('PROCESSING_STALE_AFTER_MS'), 300_000);
    this.batchSize = readPositiveInt(configService.get('PROCESSING_RECOVERY_BATCH_SIZE'), 100);
  }

  async onModuleInit(): Promise<void> {
    await this.maintenanceQueue.upsertJobScheduler(
      PROCESSING_RECOVERY_JOB,
      { every: this.intervalMs },
      { name: PROCESSING_RECOVERY_JOB, data: {} },
    );
  }

  async recoverStaleProcessing(now: Date = new Date()): Promise<{ recovered: number }> {
    const result = await this.lifecycle.recoverStaleProcessing(
      new Date(now.getTime() - this.staleAfterMs),
      this.batchSize,
    );
    this.logger.log(`PROCESSING_RECOVERY recovered=${result.recovered}`);
    return result;
  }
}

function readPositiveInt(raw: unknown, fallback: number): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
