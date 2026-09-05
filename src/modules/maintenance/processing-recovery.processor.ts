import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { PROCESSING_RECOVERY_JOB, SMS_MAINTENANCE_QUEUE } from '../queue/queue.constants';
import { ProcessingRecoveryService } from './processing-recovery.service';

@Processor(SMS_MAINTENANCE_QUEUE)
export class ProcessingRecoveryProcessor extends WorkerHost {
  constructor(private readonly recoveryService: ProcessingRecoveryService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === PROCESSING_RECOVERY_JOB) {
      await this.recoveryService.recoverStaleProcessing();
    }
  }
}
