import { ConfigService } from '@nestjs/config';

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

/**
 * Mocks the shape of the Twilio SDK's REST error, thrown by `client.messages.create`
 * for a non-2xx response (see `node_modules/twilio/lib/base/RestException.js`): a plain
 * `Error` subclass carrying the HTTP status as `.status`, not `.response.status` like axios.
 */
class FakeRestException extends Error {
  status: number;
  constructor(status: number, message = 'Request failed') {
    super(message);
    this.status = status;
  }
}

/** Mocks a Twilio SDK connection/timeout failure: a real axios error with no `.response`. */
function fakeAxiosNetworkError(code: string, message: string): Error {
  const error = new Error(message) as Error & { isAxiosError: boolean; code: string };
  error.isAxiosError = true;
  error.code = code;
  return error;
}

const createMock = jest.fn();

jest.mock('twilio', () => jest.fn(() => ({ messages: { create: createMock } })));

describe('TwilioProvider', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('calls the Twilio SDK with to/from/body and returns the sid on success', async () => {
    createMock.mockResolvedValue({ sid: 'SM-123' });
    const provider = new TwilioProvider(createConfigService());

    const result = await provider.sendSms(options);

    expect(result).toEqual({ success: true, providerMessageId: 'SM-123', isRetryable: false });
    expect(createMock).toHaveBeenCalledWith({
      to: '+14155552671',
      from: '+14155550000',
      body: 'hello',
    });
  });

  it('resolves a retryable failure on a 429 response instead of throwing', async () => {
    createMock.mockRejectedValue(new FakeRestException(429));
    const provider = new TwilioProvider(createConfigService());

    const result = await provider.sendSms(options);

    expect(result.success).toBe(false);
    expect(result.isRetryable).toBe(true);
    expect(result.providerMessageId).toBeUndefined();
  });

  it('resolves a permanent failure on a 400 response', async () => {
    createMock.mockRejectedValue(new FakeRestException(400));
    const provider = new TwilioProvider(createConfigService());

    const result = await provider.sendSms(options);

    expect(result.success).toBe(false);
    expect(result.isRetryable).toBe(false);
  });

  it('resolves an ambiguous timeout as retryable and tagged', async () => {
    createMock.mockRejectedValue(
      fakeAxiosNetworkError('ECONNABORTED', 'timeout of 10000ms exceeded'),
    );
    const provider = new TwilioProvider(createConfigService());

    const result = await provider.sendSms(options);

    expect(result.success).toBe(false);
    expect(result.isRetryable).toBe(true);
    expect(result.error).toContain('[timeout]');
  });
});
