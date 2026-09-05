import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';

import { isRetryableHttpStatus, normalizeProviderError } from './provider-error';

function httpError(status: number): AxiosError {
  const response = {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: {},
  } as AxiosResponse;
  return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', undefined, {}, response);
}

describe('isRetryableHttpStatus', () => {
  it('treats 408, 429, and all 5xx as retryable', () => {
    expect(isRetryableHttpStatus(408)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
  });

  it('treats other 4xx as permanent', () => {
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(403)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
    expect(isRetryableHttpStatus(422)).toBe(false);
  });
});

describe('normalizeProviderError', () => {
  it('classifies an aborted-connection timeout as retryable and tagged', () => {
    const error = new AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED');

    const normalized = normalizeProviderError(error, 'twilio');

    expect(normalized.kind).toBe('timeout');
    expect(normalized.isRetryable).toBe(true);
    expect(normalized.isTimeout).toBe(true);
    expect(normalized.message).toContain('[timeout]');
    expect(normalized.message).toContain('twilio');
  });

  it('classifies a network error with no response as retryable', () => {
    const error = new AxiosError('Network Error', 'ECONNREFUSED', undefined, {});

    const normalized = normalizeProviderError(error, 'bird');

    expect(normalized.kind).toBe('network');
    expect(normalized.isRetryable).toBe(true);
    expect(normalized.isTimeout).toBe(false);
    expect(normalized.message).toContain('[network]');
  });

  it('classifies retryable HTTP statuses (429, 5xx) as retryable with status captured', () => {
    const tooManyRequests = normalizeProviderError(httpError(429), 'twilio');
    expect(tooManyRequests.kind).toBe('http');
    expect(tooManyRequests.isRetryable).toBe(true);
    expect(tooManyRequests.httpStatus).toBe(429);

    const serverError = normalizeProviderError(httpError(503), 'twilio');
    expect(serverError.isRetryable).toBe(true);
    expect(serverError.httpStatus).toBe(503);
  });

  it('classifies non-retryable 4xx as permanent', () => {
    const badRequest = normalizeProviderError(httpError(400), 'twilio');
    expect(badRequest.kind).toBe('http');
    expect(badRequest.isRetryable).toBe(false);
    expect(badRequest.httpStatus).toBe(400);
  });

  it('classifies a non-axios value as a permanent unknown error', () => {
    const normalized = normalizeProviderError(new Error('boom'), 'bird');

    expect(normalized.kind).toBe('unknown');
    expect(normalized.isRetryable).toBe(false);
    expect(normalized.message).toContain('[unknown]');
  });

  it('classifies a Twilio SDK RestException (HTTP response shape) the same as an axios HTTP error', () => {
    class RestException extends Error {
      status: number;
      constructor(status: number) {
        super(`[HTTP ${status}] Failed to execute request`);
        this.status = status;
      }
    }

    const rateLimited = normalizeProviderError(new RestException(429), 'twilio');
    expect(rateLimited.kind).toBe('http');
    expect(rateLimited.isRetryable).toBe(true);
    expect(rateLimited.httpStatus).toBe(429);

    const badRequest = normalizeProviderError(new RestException(400), 'twilio');
    expect(badRequest.kind).toBe('http');
    expect(badRequest.isRetryable).toBe(false);
    expect(badRequest.httpStatus).toBe(400);
  });
});
