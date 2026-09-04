import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';

import { SendSmsOptions } from '../interfaces/sms-provider.interface';
import { TwilioProvider } from './twilio.provider';

const config: Record<string, string> = {
  TWILIO_ACCOUNT_SID: 'AC-test-sid',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  TWILIO_FROM_NUMBER: '+14155550000',
};

const options: SendSmsOptions = {
  to: '+14155552671',
  body: 'hello',
  referenceId: 'ref-1',
};

function createConfigService(): ConfigService {
  return {
    getOrThrow: (key: string) => config[key],
    get: () => undefined,
  } as unknown as ConfigService;
}

function okResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

describe('TwilioProvider', () => {
  it('POSTs a form-encoded message with basic auth and returns the sid on success', async () => {
    const post = jest.fn(() => of(okResponse({ sid: 'SM-123' })));
    const httpService = { post } as unknown as HttpService;
    const provider = new TwilioProvider(httpService, createConfigService());

    const result = await provider.sendSms(options);

    expect(result).toEqual({ success: true, providerMessageId: 'SM-123', isRetryable: false });

    const [url, requestBody, requestConfig] = post.mock.calls[0] as unknown as [
      string,
      string,
      { auth: { username: string; password: string }; headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC-test-sid/Messages.json');
    expect(requestBody).toBe('To=%2B14155552671&From=%2B14155550000&Body=hello');
    expect(requestConfig.auth).toEqual({ username: 'AC-test-sid', password: 'test-auth-token' });
    expect(requestConfig.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('resolves a retryable failure on a 429 response instead of throwing', async () => {
    const response = {
      status: 429,
      statusText: 'Too Many Requests',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: {},
    } as AxiosResponse;
    const error = new AxiosError('rate limited', 'ERR_BAD_RESPONSE', undefined, {}, response);
    const post = jest.fn(() => throwError(() => error));
    const httpService = { post } as unknown as HttpService;
    const provider = new TwilioProvider(httpService, createConfigService());

    const result = await provider.sendSms(options);

    expect(result.success).toBe(false);
    expect(result.isRetryable).toBe(true);
    expect(result.providerMessageId).toBeUndefined();
  });

  it('resolves a permanent failure on a 400 response', async () => {
    const response = {
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: {},
    } as AxiosResponse;
    const error = new AxiosError('bad request', 'ERR_BAD_REQUEST', undefined, {}, response);
    const post = jest.fn(() => throwError(() => error));
    const httpService = { post } as unknown as HttpService;
    const provider = new TwilioProvider(httpService, createConfigService());

    const result = await provider.sendSms(options);

    expect(result.success).toBe(false);
    expect(result.isRetryable).toBe(false);
  });

  it('resolves an ambiguous timeout as retryable and tagged', async () => {
    const error = new AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED');
    const post = jest.fn(() => throwError(() => error));
    const httpService = { post } as unknown as HttpService;
    const provider = new TwilioProvider(httpService, createConfigService());

    const result = await provider.sendSms(options);

    expect(result.success).toBe(false);
    expect(result.isRetryable).toBe(true);
    expect(result.error).toContain('[timeout]');
  });
});
