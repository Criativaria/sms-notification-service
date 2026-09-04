import { validateEnvironment } from './environment.validation';

const validEnvironment = {
  SERVICE_URL: 'http://localhost:3000',
  PRIVATE_NETWORK_CIDRS: '127.0.0.1/32,::1/128',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/sms_notification',
  REDIS_URL: 'redis://localhost:6379',
  SMS_PROVIDER_PRIORITY: 'twilio,bird',
  TWILIO_ACCOUNT_SID: 'account-sid',
  TWILIO_AUTH_TOKEN: 'auth-token',
  TWILIO_FROM_NUMBER: '+14155552671',
  BIRD_API_KEY: 'bird-api-key',
  BIRD_WORKSPACE_ID: 'bird-workspace',
  BIRD_CHANNEL_ID: 'bird-channel',
  BIRD_WEBHOOK_SIGNING_KEY: 'bird-webhook-key',
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
};

describe('validateEnvironment', () => {
  it('applies first-release defaults', () => {
    const config = validateEnvironment(validEnvironment);

    expect(config).toMatchObject({
      PORT: 3000,
      MAX_MESSAGE_LENGTH: 160,
      IDEMPOTENCY_TTL_HOURS: 24,
      PROVIDER_MAX_RETRY_ROUNDS: 3,
      SMS_PROVIDER_TPS: 10,
    });
  });

  it('rejects duplicate or unsupported providers', () => {
    expect(() =>
      validateEnvironment({ ...validEnvironment, SMS_PROVIDER_PRIORITY: 'twilio,unknown' }),
    ).toThrow('Environment validation failed');
  });

  it('accepts Twilio-only configuration without Bird credentials', () => {
    const twilioOnly = Object.fromEntries(
      Object.entries(validEnvironment).filter(([key]) => !key.startsWith('BIRD_')),
    );

    expect(validateEnvironment({ ...twilioOnly, SMS_PROVIDER_PRIORITY: 'twilio' })).toMatchObject({
      SMS_PROVIDER_PRIORITY: 'twilio',
    });
  });

  it('accepts Bird-only configuration without Twilio credentials', () => {
    const birdOnly = Object.fromEntries(
      Object.entries(validEnvironment).filter(([key]) => !key.startsWith('TWILIO_')),
    );

    expect(validateEnvironment({ ...birdOnly, SMS_PROVIDER_PRIORITY: 'bird' })).toMatchObject({
      SMS_PROVIDER_PRIORITY: 'bird',
    });
  });

  it('accepts configuration with both providers and their credentials', () => {
    expect(validateEnvironment(validEnvironment)).toMatchObject({
      SMS_PROVIDER_PRIORITY: 'twilio,bird',
    });
  });

  it.each([
    ['twilio', 'TWILIO_ACCOUNT_SID'],
    ['twilio', 'TWILIO_AUTH_TOKEN'],
    ['twilio', 'TWILIO_FROM_NUMBER'],
    ['bird', 'BIRD_API_KEY'],
    ['bird', 'BIRD_WORKSPACE_ID'],
    ['bird', 'BIRD_CHANNEL_ID'],
    ['bird', 'BIRD_WEBHOOK_SIGNING_KEY'],
  ])('rejects missing credentials for a selected %s provider', (provider, credential) => {
    const environment = { ...validEnvironment, SMS_PROVIDER_PRIORITY: provider };
    delete environment[credential as keyof typeof environment];

    expect(() => validateEnvironment(environment)).toThrow('Environment validation failed');
  });

  it('allows unrelated process environment variables', () => {
    expect(validateEnvironment({ ...validEnvironment, PATH: 'system-path' })).toMatchObject(
      validEnvironment,
    );
  });
});
