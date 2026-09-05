import { ConfigService } from '@nestjs/config';
import type { HttpService } from '@nestjs/axios';

import { buildConfiguredProviders } from './providers.module';
import { BirdProvider } from './strategies/bird.provider';
import { TwilioProvider } from './strategies/twilio.provider';

function configServiceWith(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) {
        throw new Error(`missing ${key}`);
      }
      return values[key];
    },
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

const httpService = {} as HttpService;

jest.mock('twilio', () => jest.fn(() => ({ messages: { create: jest.fn() } })));

describe('buildConfiguredProviders', () => {
  it('constructs only TwilioProvider for a Twilio-only environment, without requiring Bird credentials', () => {
    const configService = configServiceWith({
      SMS_PROVIDER_PRIORITY: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC-test-sid',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_FROM_NUMBER: '+14155550000',
    });

    const providers = buildConfiguredProviders(configService, httpService);

    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeInstanceOf(TwilioProvider);
  });

  it('constructs only BirdProvider for a Bird-only environment, without requiring Twilio credentials', () => {
    const configService = configServiceWith({
      SMS_PROVIDER_PRIORITY: 'bird',
      BIRD_API_KEY: 'key',
      BIRD_WORKSPACE_ID: 'workspace',
      BIRD_CHANNEL_ID: 'channel',
    });

    const providers = buildConfiguredProviders(configService, httpService);

    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeInstanceOf(BirdProvider);
  });

  it('constructs both providers, in order, when both are configured', () => {
    const configService = configServiceWith({
      SMS_PROVIDER_PRIORITY: 'twilio,bird',
      TWILIO_ACCOUNT_SID: 'AC-test-sid',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_FROM_NUMBER: '+14155550000',
      BIRD_API_KEY: 'key',
      BIRD_WORKSPACE_ID: 'workspace',
      BIRD_CHANNEL_ID: 'channel',
    });

    const providers = buildConfiguredProviders(configService, httpService);

    expect(providers).toHaveLength(2);
    expect(providers[0]).toBeInstanceOf(TwilioProvider);
    expect(providers[1]).toBeInstanceOf(BirdProvider);
  });
});
