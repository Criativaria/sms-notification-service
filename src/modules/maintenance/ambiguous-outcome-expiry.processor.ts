import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { SmsLifecycleRepository } from '../../database/sms-lifecycle.repository';
import {
  AMBIGUOUS_OUTCOME_EXPIRY_JOB,
  SMS_MAINTENANCE_QUEUE,
  SmsDispatchJobData,
} from '../queue/queue.constants';

@Processor(SMS_MAINTENANCE_QUEUE)
export class AmbiguousOutcomeExpiryProcessor extends WorkerHost {
  constructor(private readonly lifecycle: SmsLifecycleRepository) {
    super();
  }

  async process(job: Job<SmsDispatchJobData>): Promise<void> {
    if (job.name !== AMBIGUOUS_OUTCOME_EXPIRY_JOB) {
      return;
    }
    await this.lifecycle.expireAmbiguousOutcome(job.data.messageId);
  }
}
