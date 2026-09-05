import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { SMS_DISPATCH_QUEUE } from './queue.constants';

const WINDOW_MS = 1000;
const ACQUIRE_WINDOW_SLOT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
if count <= tonumber(ARGV[1]) then return 0 end
return redis.call('PTTL', KEYS[1])
`;

interface RedisEvaluator {
  eval(script: string, keyCount: number, ...args: string[]): Promise<number>;
}

@Injectable()
export class ProviderRateLimiter {
  constructor(
    @InjectQueue(SMS_DISPATCH_QUEUE) private readonly dispatchQueue: Queue,
    private readonly configService: ConfigService,
  ) {}

  async acquire(providerName: string): Promise<void> {
    const client = (await this.dispatchQueue.client) as unknown as RedisEvaluator;
    const limit = this.limitFor(providerName);

    for (;;) {
      const waitMs = await client.eval(
        ACQUIRE_WINDOW_SLOT,
        1,
        `sms:provider-tps:${providerName}`,
        String(limit),
        String(WINDOW_MS),
      );
      if (waitMs <= 0) {
        return;
      }
      await delay(waitMs);
    }
  }

  private limitFor(providerName: string): number {
    const specificLimit = this.configService.get<number>(
      `SMS_PROVIDER_TPS_${providerName.toUpperCase()}`,
    );
    return specificLimit ?? this.configService.get<number>('SMS_PROVIDER_TPS', 10);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
