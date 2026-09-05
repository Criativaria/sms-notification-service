import { Module } from '@nestjs/common';

import { QueueModule } from '../queue/queue.module';
import { RetentionProcessor } from './retention.processor';
import { RetentionService } from './retention.service';
import { ProcessingRecoveryProcessor } from './processing-recovery.processor';
import { ProcessingRecoveryService } from './processing-recovery.service';
import { AmbiguousOutcomeExpiryProcessor } from './ambiguous-outcome-expiry.processor';

/**
 * Maintenance module: background housekeeping jobs. Currently hosts the 90-day data
 * retention cleanup (`RetentionService`), which purges expired terminal SMS records on a
 * fixed interval.
 *
 * `PrismaService` is injected directly and is globally available through the `@Global`
 * `DatabaseModule`, so no imports are required here. `ConfigModule` is registered globally
 * by the app module, so `ConfigService` is likewise injectable without a local import.
 */
@Module({
  imports: [QueueModule],
  providers: [
    RetentionService,
    RetentionProcessor,
    ProcessingRecoveryService,
    ProcessingRecoveryProcessor,
    AmbiguousOutcomeExpiryProcessor,
  ],
  exports: [RetentionService],
})
export class MaintenanceModule {}
