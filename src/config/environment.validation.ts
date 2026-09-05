import * as Joi from 'joi';

const supportedProviders = ['twilio', 'bird'] as const;
type ValidatedEnvironment = Record<string, unknown> & { SMS_PROVIDER_PRIORITY: string };

const configurationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  PRIVATE_NETWORK_CIDRS: Joi.string().min(1).required(),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),
  SMS_PROVIDER_PRIORITY: Joi.string()
    .custom((value: string, helpers) => {
      const providers = value.split(',').map((provider) => provider.trim());
      if (
        providers.length === 0 ||
        providers.some(
          (provider) =>
            !supportedProviders.includes(provider as (typeof supportedProviders)[number]),
        ) ||
        new Set(providers).size !== providers.length
      ) {
        return helpers.error('any.invalid');
      }
      return providers.join(',');
    })
    .required(),
  TWILIO_ACCOUNT_SID: Joi.string().min(1),
  TWILIO_AUTH_TOKEN: Joi.string().min(1),
  TWILIO_FROM_NUMBER: Joi.string().min(1),
  TWILIO_API_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://api.twilio.com'),
  BIRD_API_KEY: Joi.string().min(1),
  BIRD_WORKSPACE_ID: Joi.string().min(1),
  BIRD_CHANNEL_ID: Joi.string().min(1),
  BIRD_WEBHOOK_SIGNING_KEY: Joi.string().min(1),
  BIRD_API_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://api.bird.com'),
  MAX_MESSAGE_LENGTH: Joi.number().integer().positive().default(160),
  IDEMPOTENCY_TTL_HOURS: Joi.number().integer().positive().default(24),
  PROVIDER_MAX_RETRY_ROUNDS: Joi.number().integer().positive().default(3),
  SMS_PROVIDER_TPS: Joi.number().integer().positive().default(10),
  SMS_PROVIDER_TPS_TWILIO: Joi.number().integer().positive(),
  SMS_PROVIDER_TPS_BIRD: Joi.number().integer().positive(),
  PROCESSING_RECOVERY_INTERVAL_MS: Joi.number().integer().positive().default(60_000),
  PROCESSING_STALE_AFTER_MS: Joi.number().integer().positive().default(300_000),
  PROCESSING_RECOVERY_BATCH_SIZE: Joi.number().integer().positive().default(100),
  AMBIGUOUS_OUTCOME_EXPIRY_MS: Joi.number().integer().positive().default(900_000),
  ENCRYPTION_KEY: Joi.string()
    .base64()
    .custom((value: string, helpers) =>
      Buffer.from(value, 'base64').length === 32 ? value : helpers.error('any.invalid'),
    )
    .required(),
})
  .custom((value: ValidatedEnvironment, helpers) => {
    const providers = value.SMS_PROVIDER_PRIORITY.split(',');
    const requiredCredentials = {
      twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
      bird: ['BIRD_API_KEY', 'BIRD_WORKSPACE_ID', 'BIRD_CHANNEL_ID', 'BIRD_WEBHOOK_SIGNING_KEY'],
    } as const;

    for (const provider of providers) {
      const missingCredential = requiredCredentials[
        provider as keyof typeof requiredCredentials
      ].find((credential) => !value[credential]);

      if (missingCredential) {
        return helpers.message({
          custom: `${missingCredential} is required when ${provider} is configured`,
        });
      }
    }

    return value;
  })
  .unknown(true);

export function validateEnvironment(config: Record<string, unknown>): Record<string, unknown> {
  const result = configurationSchema.validate(config, {
    abortEarly: false,
    convert: true,
  }) as Joi.ValidationResult<Record<string, unknown>>;

  if (result.error) {
    throw new Error(`Environment validation failed: ${result.error.message}`);
  }

  return result.value;
}
