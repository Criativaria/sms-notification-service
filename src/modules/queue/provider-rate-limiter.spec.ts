import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { ProviderRateLimiter } from './provider-rate-limiter';

describe('ProviderRateLimiter', () => {
  it('uses independent Redis keys and configured limits for Twilio and Bird', async () => {
    const evalMock = jest.fn().mockResolvedValue(0);
    const queue = { client: Promise.resolve({ eval: evalMock }) } as unknown as Queue;
    const limiter = new ProviderRateLimiter(
      queue,
      new ConfigService({ SMS_PROVIDER_TPS: 10, SMS_PROVIDER_TPS_TWILIO: 5 }),
    );

    await limiter.acquire('twilio');
    await limiter.acquire('bird');

    expect(evalMock).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      1,
      'sms:provider-tps:twilio',
      '5',
      '1000',
    );
    expect(evalMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      1,
      'sms:provider-tps:bird',
      '10',
      '1000',
    );
  });
});
