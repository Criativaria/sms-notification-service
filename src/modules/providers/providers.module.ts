import { HttpModule, HttpService } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ISmsProvider } from './interfaces/sms-provider.interface';
import { ProviderFactory, SMS_PROVIDERS } from './provider.factory';
import { ProviderManager } from './provider-manager';
import { BirdProvider } from './strategies/bird.provider';
import { TwilioProvider } from './strategies/twilio.provider';

/**
 * Builds only the provider strategies actually listed in `SMS_PROVIDER_PRIORITY`.
 *
 * `TwilioProvider`/`BirdProvider` read their required credentials with
 * `configService.getOrThrow` in their own constructors, which is correct for a provider that
 * is actually configured but would otherwise fail Nest startup for a provider that is not
 * (e.g. a Twilio-only deployment has no `BIRD_*` values, by design — see
 * `environment.validation.ts`'s per-provider credential check). Rather than registering both
 * classes as Nest providers (which forces eager DI construction of both regardless of
 * `SMS_PROVIDER_PRIORITY`), this factory constructs only the configured ones by hand, once
 * `ConfigService` has already validated the environment.
 */
export function buildConfiguredProviders(
  configService: ConfigService,
  httpService: HttpService,
): ISmsProvider[] {
  const configuredNames = configService
    .getOrThrow<string>('SMS_PROVIDER_PRIORITY')
    .split(',')
    .map((name) => name.trim());

  const builders: Record<string, () => ISmsProvider> = {
    twilio: () => new TwilioProvider(configService),
    bird: () => new BirdProvider(httpService, configService),
  };

  return configuredNames
    .map((name) => builders[name])
    .filter((build): build is () => ISmsProvider => build !== undefined)
    .map((build) => build());
}

@Module({
  imports: [HttpModule],
  providers: [
    {
      provide: SMS_PROVIDERS,
      useFactory: buildConfiguredProviders,
      inject: [ConfigService, HttpService],
    },
    ProviderFactory,
    ProviderManager,
  ],
  exports: [ProviderManager, ProviderFactory],
})
export class ProvidersModule {}
