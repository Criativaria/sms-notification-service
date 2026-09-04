import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';

import { SendSmsOptions } from '../interfaces/sms-provider.interface';
import { BirdProvider } from './bird.provider';

const config: Record<string, string> = {
  BIRD_API_KEY: 'bird-key',
  BIRD_WORKSPACE_ID: 'ws-1',
  BIRD_CHANNEL_ID: 'ch-1',
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

describe('BirdProvider', () => {
  it('POSTs JSON to the workspace/channel endpoint with an AccessKey header and returns the id', async () => {
    const post = jest.fn(() => of(okResponse({ id: 'bird-msg-1' })));
    const httpService = { post } as unknown as HttpService;
    const provider = new BirdProvider(httpService, createConfigService());

    const result = await provider.sendSms(options);

    expect(result).toEqual({ success: true, providerMessageId: 'bird-msg-1', isRetryable: false });

    const [url, payload, requestConfig] = post.mock.calls[0] as unknown as [
      string,
      { receiver: { contacts: { identifierValue: string }[] }; reference: string },
      { headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.bird.com/workspaces/ws-1/channels/ch-1/messages');
    expect(payload.receiver.contacts[0]?.identifierValue).toBe('+14155552671');
    expect(payload.reference).toBe('ref-1');
    expect(requestConfig.headers.Authorization).toBe('AccessKey bird-key');
  });

  it('resolves a retryable failure on a 500 response', async () => {
    const response = {
      status: 500,
      statusText: 'Server Error',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: {},
    } as AxiosResponse;
    const error = new AxiosError('server error', 'ERR_BAD_RESPONSE', undefined, {}, response);
    const post = jest.fn(() => throwError(() => error));
    const httpService = { post } as unknown as HttpService;
    const provider = new BirdProvider(httpService, createConfigService());

    const result = await provider.sendSms(options);

    expect(result.success).toBe(false);
    expect(result.isRetryable).toBe(true);
  });

  it('resolves a retryable failure on a network error with no response', async () => {
    const error = new AxiosError('Network Error', 'ECONNRESET', undefined, {});
    const post = jest.fn(() => throwError(() => error));
    const httpService = { post } as unknown as HttpService;
    const provider = new BirdProvider(httpService, createConfigService());

    const result = await provider.sendSms(options);

    expect(result.success).toBe(false);
    expect(result.isRetryable).toBe(true);
    expect(result.error).toContain('[network]');
  });
});
