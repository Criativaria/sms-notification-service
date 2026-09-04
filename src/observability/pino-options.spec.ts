import { pinoHttpOptions, REDACT_CENSOR, REDACT_PATHS } from './pino-options';

function redact(): { paths: string[]; censor: string } {
  const value = pinoHttpOptions.redact;
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('expected redact to be configured as an object');
  }
  return value as { paths: string[]; censor: string };
}

describe('pinoHttpOptions', () => {
  it('uses the fixed censor string', () => {
    expect(REDACT_CENSOR).toBe('[REDACTED]');
    expect(redact().censor).toBe('[REDACTED]');
  });

  it('redacts the sensitive request headers', () => {
    const paths = redact().paths;
    expect(paths).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers["x-twilio-signature"]',
        'req.headers["x-bird-signature"]',
        'req.headers["x-idempotency-key"]',
      ]),
    );
  });

  it('redacts PII/content fields at the top level and one level deep', () => {
    const paths = redact().paths;
    for (const field of ['recipientPhone', 'to', 'messageBody', 'body', 'encryptedMessage']) {
      expect(paths).toContain(field);
      expect(paths).toContain(`*.${field}`);
    }
  });

  it('does not redact the bare `message` key so error messages stay diagnosable', () => {
    const paths = redact().paths;
    expect(paths).not.toContain('message');
    expect(paths).not.toContain('*.message');
  });

  it('exposes the same paths through REDACT_PATHS', () => {
    expect(redact().paths).toBe(REDACT_PATHS);
  });

  it('defaults the level to info when LOG_LEVEL is unset', () => {
    // setup-env may set LOG_LEVEL; assert it is at least a valid pino level string.
    expect(typeof pinoHttpOptions.level).toBe('string');
    expect(pinoHttpOptions.level).toBe(process.env.LOG_LEVEL ?? 'info');
  });

  it('does not enable pino-pretty transport (pure JSON output)', () => {
    expect(pinoHttpOptions.transport).toBeUndefined();
  });

  it('ignores the health endpoint in automatic logging', () => {
    const autoLogging = pinoHttpOptions.autoLogging;
    if (typeof autoLogging !== 'object' || autoLogging === null) {
      throw new Error('expected autoLogging to be configured as an object');
    }
    const ignore = autoLogging.ignore;
    expect(ignore).toBeDefined();
    expect(ignore?.({ url: '/health' } as never)).toBe(true);
    expect(ignore?.({ url: '/v1/messages' } as never)).toBe(false);
  });
});
