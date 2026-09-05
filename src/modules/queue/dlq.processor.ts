import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { MetricsService } from '../../observability/metrics.service';
import { SMS_DLQ_QUEUE, SmsDispatchJobData } from './queue.constants';

/**
 * Consumes dead-letter notifications without making Redis queue state part of recovery.
 * The lifecycle row, attempt audit trail, and outbox event in PostgreSQL remain authoritative.
 */
@Processor(SMS_DLQ_QUEUE)
export class DlqProcessor extends WorkerHost {
  private readonly logger = new Logger(DlqProcessor.name);

  constructor(private readonly metrics: MetricsService) {
    super();
  }

  process(job: Job<SmsDispatchJobData>): Promise<{ status: 'notified' }> {
    this.metrics.recordDeadLetterNotification();
    this.logger.warn(`DLQ_NOTIFICATION_PROCESSED messageId=${job.data.messageId}`);
    return Promise.resolve({ status: 'notified' });
  }
}
