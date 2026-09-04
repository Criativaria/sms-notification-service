import { Module } from '@nestjs/common';

import { RetentionService } from './retention.service';

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
  providers: [RetentionService],
  exports: [RetentionService],
})
export class MaintenanceModule {}
