import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnvironment } from './config/environment.validation';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { QueueModule } from './modules/queue/queue.module';
import { SmsModule } from './modules/sms/sms.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { ObservabilityModule } from './observability/logging.module';

@Module({
  imports: [
    ObservabilityModule,
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    ProvidersModule,
    SmsModule,
    QueueModule,
    WebhooksModule,
    MaintenanceModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
