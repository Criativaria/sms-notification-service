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
 * Normalizes any thrown value from a provider HTTP call into a stable,
 * PII-free descriptor. Never includes phone numbers or message bodies, and
 * never re-throws — callers translate this into a SendSmsResult.
 */
export function normalizeProviderError(
  error: unknown,
  providerName: string,
): NormalizedProviderError {
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
