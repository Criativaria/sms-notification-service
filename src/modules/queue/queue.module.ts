import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { CryptoModule } from '../../common/crypto/crypto.module';
import { MetricsController } from '../../observability/metrics.controller';
import { MetricsService } from '../../observability/metrics.service';
import { ProvidersModule } from '../providers/providers.module';
import { DlqController } from './dlq.controller';
import { DlqProcessor } from './dlq.processor';
import { OutboxRelayService } from './outbox-relay.service';
import { ProviderRateLimiter } from './provider-rate-limiter';
import { SmsProcessor } from './sms.processor';
import { SMS_DISPATCH_QUEUE, SMS_DLQ_QUEUE, SMS_MAINTENANCE_QUEUE } from './queue.constants';

/**
 * Reliable-delivery queue module: the transactional-outbox relay, the dispatch worker
 * (retry rounds + exponential backoff + per-provider rate limit), and the DLQ requeue
 * endpoint.
 *
 * `BullModule.forRootAsync` here registers the root BullMQ connection from `REDIS_URL`,
 * so the app module only needs to import `QueueModule` — no additional `forRoot` wiring.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: { url: configService.getOrThrow<string>('REDIS_URL') },
      }),
    }),
    BullModule.registerQueue(
      { name: SMS_DISPATCH_QUEUE },
      { name: SMS_DLQ_QUEUE },
      { name: SMS_MAINTENANCE_QUEUE },
    ),
    ProvidersModule,
    CryptoModule,
  ],
  controllers: [DlqController, MetricsController],
  providers: [OutboxRelayService, ProviderRateLimiter, SmsProcessor, DlqProcessor, MetricsService],
  exports: [BullModule],
})
export class QueueModule {}
