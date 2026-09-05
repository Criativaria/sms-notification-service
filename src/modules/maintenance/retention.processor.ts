import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { RETENTION_CLEANUP_JOB, SMS_MAINTENANCE_QUEUE } from '../queue/queue.constants';
import { RetentionService } from './retention.service';

@Processor(SMS_MAINTENANCE_QUEUE)
export class RetentionProcessor extends WorkerHost {
  constructor(private readonly retentionService: RetentionService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== RETENTION_CLEANUP_JOB) {
      return;
    }
    await this.retentionService.purgeExpired();
  }
}
