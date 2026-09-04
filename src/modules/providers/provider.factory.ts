import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ISmsProvider } from './interfaces/sms-provider.interface';

/** Injection token for the collection of registered ISmsProvider strategies. */
export const SMS_PROVIDERS = Symbol('SMS_PROVIDERS');

/**
 * Registry of SMS providers keyed by providerName. Resolves providers by name
 * and lists them in the priority order declared by SMS_PROVIDER_PRIORITY.
 *
 * Adding a new provider requires only implementing ISmsProvider and registering
 * it through the SMS_PROVIDERS token — no changes here or in ProviderManager.
 */
@Injectable()
export class ProviderFactory {
  private readonly registry = new Map<string, ISmsProvider>();
  private readonly priority: string[];

  constructor(configService: ConfigService, @Inject(SMS_PROVIDERS) providers: ISmsProvider[]) {
    for (const provider of providers) {
      this.registry.set(provider.providerName, provider);
    }

    this.priority = configService
      .getOrThrow<string>('SMS_PROVIDER_PRIORITY')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  }

  getProvider(name: string): ISmsProvider | undefined {
    return this.registry.get(name);
  }

  /** Registered providers in configured priority order; unknown names skipped. */
  getOrderedProviders(): ISmsProvider[] {
    return this.priority
      .map((name) => this.registry.get(name))
      .filter((provider): provider is ISmsProvider => provider !== undefined);
  }
}
