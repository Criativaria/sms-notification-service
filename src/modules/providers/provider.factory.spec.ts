import { ConfigService } from '@nestjs/config';

import { ISmsProvider, SendSmsResult } from './interfaces/sms-provider.interface';
import { ProviderFactory } from './provider.factory';

function stubProvider(name: string): ISmsProvider {
  return {
    providerName: name,
    sendSms: (): Promise<SendSmsResult> => Promise.resolve({ success: true, isRetryable: false }),
  };
}

function createConfigService(priority: string): ConfigService {
  return {
    getOrThrow: () => priority,
  } as unknown as ConfigService;
}

describe('ProviderFactory', () => {
  it('resolves registered providers by name', () => {
    const twilio = stubProvider('twilio');
    const bird = stubProvider('bird');
    const factory = new ProviderFactory(createConfigService('twilio,bird'), [twilio, bird]);

    expect(factory.getProvider('twilio')).toBe(twilio);
    expect(factory.getProvider('bird')).toBe(bird);
    expect(factory.getProvider('unknown')).toBeUndefined();
  });

  it('lists providers in the configured priority order', () => {
    const twilio = stubProvider('twilio');
    const bird = stubProvider('bird');
    const factory = new ProviderFactory(createConfigService('bird, twilio'), [twilio, bird]);

    expect(factory.getOrderedProviders().map((provider) => provider.providerName)).toEqual([
      'bird',
      'twilio',
    ]);
  });

  it('skips priority names that have no registered provider', () => {
    const twilio = stubProvider('twilio');
    const factory = new ProviderFactory(createConfigService('twilio,bird'), [twilio]);

    expect(factory.getOrderedProviders().map((provider) => provider.providerName)).toEqual([
      'twilio',
    ]);
  });
});
