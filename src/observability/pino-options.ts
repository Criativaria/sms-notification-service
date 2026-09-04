import type { IncomingMessage, ServerResponse } from 'http';

import type { Options } from 'pino-http';

/**
 * Censor string written in place of any redacted value.
 */
export const REDACT_CENSOR = '[REDACTED]';

/**
 * Endpoint whose automatic request/response logging is suppressed to keep the
 * logs quiet under health-check polling.
 */
const HEALTH_PATH = '/health';

/**
 * Fields that may carry PII or message content anywhere in a logged object.
 * Pino wildcards match a single level, so each field is listed both at the top
 * level and one level deep (`*.field`).
 *
 * The bare `message` key is intentionally NOT redacted: `*.message` would also
 * censor `err.message`, making provider/error diagnostics unreadable. The SMS
 * text is only ever named `messageBody`/`body`/`encryptedMessage` in our logs,
 * and request bodies are never serialized, so those names give full coverage
 * without clobbering error messages.
 */
const SENSITIVE_FIELDS = ['recipientPhone', 'to', 'messageBody', 'body', 'encryptedMessage'];

/**
 * Full set of Pino redact paths applied to every log line. Sensitive request
 * headers plus any sensitive field at the top level or one level deep.
 */
export const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers["x-twilio-signature"]',
  'req.headers["x-bird-signature"]',
  'req.headers["x-idempotency-key"]',
  ...SENSITIVE_FIELDS,
  ...SENSITIVE_FIELDS.map((field) => `*.${field}`),
];

type LoggableRequest = IncomingMessage & {
  id?: string | number;
  originalUrl?: string;
};

/**
 * Pino/`pino-http` options for the SMS service.
 *
 * - Pure JSON output (no `pino-pretty`) for production ingestion.
 * - Level driven by `LOG_LEVEL`, defaulting to `info`.
 * - Redaction of sensitive headers and PII/content fields with a fixed censor.
 * - Request/response serializers that never include request bodies.
 * - Automatic logging suppressed for the health endpoint.
 */
export const pinoHttpOptions: Options = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: REDACT_PATHS,
    censor: REDACT_CENSOR,
  },
  autoLogging: {
    ignore: (req: IncomingMessage) => req.url === HEALTH_PATH,
  },
  serializers: {
    req(request: LoggableRequest) {
      return {
        id: request.id,
        method: request.method,
        url: request.url ?? request.originalUrl,
        headers: request.headers,
      };
    },
    res(response: ServerResponse) {
      return {
        statusCode: response.statusCode,
      };
    },
  },
  // Explicitly attach no request-derived properties, guaranteeing bodies are
  // never copied into the log record.
  customProps: () => ({}),
};
