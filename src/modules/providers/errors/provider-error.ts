import axios from 'axios';

export type ProviderErrorKind = 'timeout' | 'network' | 'http' | 'unknown';

export interface NormalizedProviderError {
  /** Safe, PII-free description suitable for logging and auditing. */
  message: string;
  isRetryable: boolean;
  isTimeout: boolean;
  kind: ProviderErrorKind;
  httpStatus?: number;
}

/**
 * Retryable HTTP statuses: request timeout (408), too many requests (429),
 * and any server error (5xx). Every other status is treated as permanent.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isTimeoutCode(code: string | undefined): boolean {
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT';
}

/**
 * Shape of the error the Twilio SDK throws for a non-2xx REST API response
 * (`node_modules/twilio/lib/base/RestException.js`): a plain `Error` subclass
 * carrying the HTTP status as `.status`, never `.response.status` like axios.
 */
interface TwilioRestException {
  status: number;
  message?: string;
  code?: number;
}

function isTwilioRestException(error: unknown): error is TwilioRestException {
  return (
    error instanceof Error &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  );
}

/**
 * Normalizes any thrown value from a provider HTTP call into a stable,
 * PII-free descriptor. Never includes phone numbers or message bodies, and
 * never re-throws — callers translate this into a SendSmsResult.
 */
export function normalizeProviderError(
  error: unknown,
  providerName: string,
): NormalizedProviderError {
  // The Twilio SDK's internal RequestClient (node_modules/twilio/lib/base/RequestClient.js)
  // is itself axios-based: it never throws for a received HTTP response (it accepts any status
  // 100-599 and lets `Version.throwException` turn 3xx/4xx/5xx into a `RestException`), and it
  // rejects with a genuine `AxiosError` (no `.response`) for connection failures/timeouts. So a
  // real network/timeout failure from the Twilio SDK still satisfies `axios.isAxiosError` and is
  // handled by the branch below; only the "got an HTTP response" case needs a Twilio-specific
  // branch, since `RestException` carries `.status` directly instead of `.response.status`.
  if (isTwilioRestException(error)) {
    const status = error.status;
    return {
      message: `[http] ${providerName} responded with status ${status}`,
      isRetryable: isRetryableHttpStatus(status),
      isTimeout: false,
      kind: 'http',
      httpStatus: status,
    };
  }

  if (axios.isAxiosError(error)) {
    const code = error.code;
    const status = error.response?.status;

    if (isTimeoutCode(code) || (status === undefined && /timeout/i.test(error.message))) {
      return {
        message: `[timeout] ${providerName} request timed out`,
        isRetryable: true,
        isTimeout: true,
        kind: 'timeout',
      };
    }

    if (status !== undefined) {
      return {
        message: `[http] ${providerName} responded with status ${status}`,
        isRetryable: isRetryableHttpStatus(status),
        isTimeout: false,
        kind: 'http',
        httpStatus: status,
      };
    }

    return {
      message: `[network] ${providerName} network error${code ? ` (${code})` : ''}`,
      isRetryable: true,
      isTimeout: false,
      kind: 'network',
    };
  }

  return {
    message: `[unknown] ${providerName} unexpected error`,
    isRetryable: false,
    isTimeout: false,
    kind: 'unknown',
  };
}
