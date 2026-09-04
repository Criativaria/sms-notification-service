import { ConfigService } from '@nestjs/config';

export const DEFAULT_PROVIDER_TIMEOUT_MS = 10000;

/**
 * Reads the optional PROVIDER_TIMEOUT_MS config value. It is intentionally not
 * part of the Joi schema, so it arrives as an unconverted string (or undefined)
 * and must be parsed defensively with a safe fallback.
 */
export function resolveProviderTimeoutMs(configService: ConfigService): number {
  const raw = configService.get<string | number>('PROVIDER_TIMEOUT_MS');
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROVIDER_TIMEOUT_MS;
}
