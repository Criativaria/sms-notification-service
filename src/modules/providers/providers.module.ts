import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { ISmsProvider } from './interfaces/sms-provider.interface';
import { ProviderFactory, SMS_PROVIDERS } from './provider.factory';
import { ProviderManager } from './provider-manager';
import { BirdProvider } from './strategies/bird.provider';
import { TwilioProvider } from './strategies/twilio.provider';

@Module({
  imports: [HttpModule],
  providers: [
    TwilioProvider,
    BirdProvider,
    {
      provide: SMS_PROVIDERS,
      useFactory: (twilio: TwilioProvider, bird: BirdProvider): ISmsProvider[] => [twilio, bird],
      inject: [TwilioProvider, BirdProvider],
    },
    ProviderFactory,
    ProviderManager,
  ],
  exports: [ProviderManager, ProviderFactory],
})
export class ProvidersModule {}
