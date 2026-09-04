import { Module } from '@nestjs/common';

import { BirdWebhookController } from './bird-webhook.controller';
import { TwilioWebhookController } from './twilio-webhook.controller';
import { WebhooksService } from './webhooks.service';

/**
 * Wires the authenticated Twilio and Bird delivery-report webhook endpoints. Depends on
 * the global {@link DatabaseModule} for `SmsLifecycleRepository` and the global
 * `ConfigService` for signing secrets and the service URL.
 */
@Module({
  controllers: [TwilioWebhookController, BirdWebhookController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
