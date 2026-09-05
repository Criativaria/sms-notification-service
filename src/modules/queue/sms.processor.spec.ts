import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';

import { EncryptionService } from '../../common/crypto/encryption.service';
import { PrismaService } from '../../database/prisma.service';
import {
  BeginProcessingResult,
  LifecycleSmsMessage,
  SmsLifecycleRepository,
} from '../../database/sms-lifecycle.repository';
import { ProviderFactory } from '../providers/provider.factory';
import { ISmsProvider, SendSmsResult } from '../providers/interfaces/sms-provider.interface';
import { SmsProcessor } from './sms.processor';
import { ProviderRateLimiter } from './provider-rate-limiter';
import { SmsDispatchJobData } from './queue.constants';

const MESSAGE_ID = 'msg-1';

function processingMessage(overrides: Partial<LifecycleSmsMessage> = {}): LifecycleSmsMessage {
  return {
    id: MESSAGE_ID,
    status: 'PROCESSING',
    selectedProvider: null,
    providerMessageId: null,
    lastError: null,
    deliveryAttempts: 0,
    retryRounds: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface Mocks {
  lifecycle: {
    beginProcessing: jest.Mock;
    reserveProviderAttempt: jest.Mock;
    finalizeProviderAttempt: jest.Mock;
    scheduleRetry: jest.Mock;
    markFatalFailure: jest.Mock;
  };
  providerFactory: { getProvider: jest.Mock; getOrderedProviders: jest.Mock };
  encryption: { decrypt: jest.Mock };
  prisma: { smsMessage: { findUnique: jest.Mock } };
  providerRateLimiter: { acquire: jest.Mock };
}

interface StubProvider {
  providerName: string;
  // Declared as a plain property (not an interface method) so `expect(stub.sendSms)...`
  // assertions do not trip @typescript-eslint/unbound-method.
  sendSms: jest.Mock<Promise<SendSmsResult>, [unknown]>;
}

function stubProvider(name: string, ...results: SendSmsResult[]): StubProvider {
  const sendSms = jest.fn<Promise<SendSmsResult>, [unknown]>();
  results.forEach((result) => sendSms.mockResolvedValueOnce(result));
  return { providerName: name, sendSms };
}

function asProvider(stub: StubProvider): ISmsProvider {
  return stub;
}

function buildMocks(stubs: StubProvider[] = [stubProvider('twilio')]): Mocks {
  const providers = stubs.map(asProvider);
  let attemptCounter = 0;
  return {
    lifecycle: {
      beginProcessing: jest.fn().mockResolvedValue({
        outcome: 'started',
        message: processingMessage(),
      } satisfies BeginProcessingResult),
      reserveProviderAttempt: jest.fn().mockImplementation(() => {
        attemptCounter += 1;
        return Promise.resolve({ outcome: 'reserved', attemptId: `attempt-${attemptCounter}` });
      }),
      finalizeProviderAttempt: jest.fn().mockResolvedValue(undefined),
      scheduleRetry: jest.fn().mockResolvedValue(undefined),
      markFatalFailure: jest.fn().mockResolvedValue(undefined),
    },
    providerFactory: {
      getProvider: jest.fn((name: string) => providers.find((p) => p.providerName === name)),
      getOrderedProviders: jest.fn().mockReturnValue(providers),
    },
    encryption: { decrypt: jest.fn().mockReturnValue('hello world') },
    prisma: {
      smsMessage: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ recipientPhone: '+14155552671', encryptedMessage: 'cipher' }),
      },
    },
    providerRateLimiter: { acquire: jest.fn().mockResolvedValue(undefined) },
  };
}

function buildProcessor(mocks: Mocks, config: Record<string, unknown> = {}): SmsProcessor {
  return new SmsProcessor(
    mocks.lifecycle as unknown as SmsLifecycleRepository,
    mocks.providerFactory as unknown as ProviderFactory,
    mocks.encryption as unknown as EncryptionService,
    mocks.prisma as unknown as PrismaService,
    mocks.providerRateLimiter as unknown as ProviderRateLimiter,
    new ConfigService({ PROVIDER_MAX_RETRY_ROUNDS: 3, ...config }),
  );
}

function job(): Job<SmsDispatchJobData> {
  return { data: { messageId: MESSAGE_ID } } as unknown as Job<SmsDispatchJobData>;
}

describe('SmsProcessor', () => {
  it('reserves the provider attempt before invocation and atomically finalizes an accepted result', async () => {
    const twilio = stubProvider('twilio', {
      success: true,
      providerMessageId: 'twilio-message-1',
      isRetryable: false,
    });
    const mocks = buildMocks([twilio]);
    const processor = buildProcessor(mocks);

    const outcome = await processor.process(job());

    expect(outcome).toEqual({ status: 'sent', provider: 'twilio' });
    expect(mocks.lifecycle.reserveProviderAttempt.mock.invocationCallOrder[0]!).toBeLessThan(
      twilio.sendSms.mock.invocationCallOrder[0]!,
    );
    expect(mocks.providerRateLimiter.acquire).toHaveBeenCalledWith('twilio');
    expect(mocks.lifecycle.finalizeProviderAttempt).toHaveBeenCalledWith(MESSAGE_ID, 'attempt-1', {
      outcome: 'ACCEPTED',
      providerMessageId: 'twilio-message-1',
    });
  });

  it('invokes the provider once when a duplicate or restarted job replays after reservation', async () => {
    const twilio = stubProvider('twilio', {
      success: false,
      error: '[timeout] request timed out',
      isRetryable: true,
      isAmbiguous: true,
    });
    const mocks = buildMocks([twilio]);
    mocks.lifecycle.beginProcessing
      .mockResolvedValueOnce({ outcome: 'started', message: processingMessage() })
      .mockResolvedValueOnce({ outcome: 'not_startable' });
    const processor = buildProcessor(mocks);

    await processor.process(job());
    const replay = await processor.process(job());

    expect(replay).toEqual({ status: 'skipped' });
    expect(twilio.sendSms).toHaveBeenCalledTimes(1);
  });

  it('leaves an ambiguous outcome awaiting explicit action instead of failing over or retrying', async () => {
    const twilio = stubProvider('twilio', {
      success: false,
      error: '[timeout] request timed out',
      isRetryable: true,
      isAmbiguous: true,
    });
    const bird = stubProvider('bird', {
      success: true,
      providerMessageId: 'bird-1',
      isRetryable: false,
    });
    const mocks = buildMocks([twilio, bird]);
    const processor = buildProcessor(mocks);

    const outcome = await processor.process(job());

    expect(outcome).toEqual({ status: 'awaiting-provider-result' });
    expect(mocks.lifecycle.finalizeProviderAttempt).toHaveBeenCalledWith(MESSAGE_ID, 'attempt-1', {
      outcome: 'FAILED',
      isAmbiguous: true,
      isRetryable: true,
      errorMessage: '[timeout] request timed out',
      ambiguousOutcomeExpiryMs: 900000,
    });
    // Never tries Bird after an ambiguous Twilio outcome.
    expect(bird.sendSms).not.toHaveBeenCalled();
  });

  it('treats a successful response without a provider message id as ambiguous, not sent', async () => {
    const twilio = stubProvider('twilio', { success: true, isRetryable: false });
    const bird = stubProvider('bird', {
      success: true,
      providerMessageId: 'bird-1',
      isRetryable: false,
    });
    const mocks = buildMocks([twilio, bird]);
    const processor = buildProcessor(mocks);

    const outcome = await processor.process(job());

    expect(outcome).toEqual({ status: 'awaiting-provider-result' });
    expect(mocks.lifecycle.finalizeProviderAttempt).toHaveBeenCalledWith(MESSAGE_ID, 'attempt-1', {
      outcome: 'FAILED',
      isAmbiguous: true,
      isRetryable: false,
      errorMessage: 'Provider accepted response did not include a valid message id',
      ambiguousOutcomeExpiryMs: 900000,
    });
    expect(bird.sendSms).not.toHaveBeenCalled();
  });

  it('fails over to the next provider within the same pass on a definitive retryable failure', async () => {
    const twilio = stubProvider('twilio', {
      success: false,
      error: '[http] twilio responded with status 503',
      isRetryable: true,
      isAmbiguous: false,
    });
    const bird = stubProvider('bird', {
      success: true,
      providerMessageId: 'bird-1',
      isRetryable: false,
    });
    const mocks = buildMocks([twilio, bird]);
    const processor = buildProcessor(mocks);

    const outcome = await processor.process(job());

    expect(outcome).toEqual({ status: 'sent', provider: 'bird' });
    expect(twilio.sendSms).toHaveBeenCalledTimes(1);
    expect(bird.sendSms).toHaveBeenCalledTimes(1);
    expect(mocks.lifecycle.reserveProviderAttempt).toHaveBeenNthCalledWith(1, MESSAGE_ID, 'twilio');
    expect(mocks.lifecycle.reserveProviderAttempt).toHaveBeenNthCalledWith(2, MESSAGE_ID, 'bird');
    expect(mocks.providerRateLimiter.acquire).toHaveBeenNthCalledWith(1, 'twilio');
    expect(mocks.providerRateLimiter.acquire).toHaveBeenNthCalledWith(2, 'bird');
    expect(mocks.lifecycle.finalizeProviderAttempt).toHaveBeenNthCalledWith(
      1,
      MESSAGE_ID,
      'attempt-1',
      {
        outcome: 'FAILED',
        isAmbiguous: false,
        isRetryable: true,
        errorMessage: '[http] twilio responded with status 503',
      },
    );
    expect(mocks.lifecycle.finalizeProviderAttempt).toHaveBeenNthCalledWith(
      2,
      MESSAGE_ID,
      'attempt-2',
      {
        outcome: 'ACCEPTED',
        providerMessageId: 'bird-1',
      },
    );
  });

  it('schedules a backed-off retry round when every provider fails definitively and transiently', async () => {
    const twilio = stubProvider('twilio', {
      success: false,
      error: '[http] twilio responded with status 503',
      isRetryable: true,
      isAmbiguous: false,
    });
    const bird = stubProvider('bird', {
      success: false,
      error: '[http] bird responded with status 429',
      isRetryable: true,
      isAmbiguous: false,
    });
    const mocks = buildMocks([twilio, bird]);
    const processor = buildProcessor(mocks);

    const outcome = await processor.process(job());

    expect(outcome).toEqual({ status: 'retry-scheduled' });
    expect(mocks.lifecycle.scheduleRetry).toHaveBeenCalledWith(MESSAGE_ID, {
      incrementRound: true,
      delayMs: 2000,
      lastError: 'twilio:failed, bird:failed',
    });
    expect(mocks.lifecycle.markFatalFailure).not.toHaveBeenCalled();
  });

  it('dead-letters immediately when every provider fails permanently (no retryable attempt)', async () => {
    const twilio = stubProvider('twilio', {
      success: false,
      error: '[http] twilio responded with status 400',
      isRetryable: false,
      isAmbiguous: false,
    });
    const mocks = buildMocks([twilio]);
    const processor = buildProcessor(mocks);

    const outcome = await processor.process(job());

    expect(outcome).toEqual({ status: 'dead-letter', reason: 'permanent' });
    expect(mocks.lifecycle.scheduleRetry).not.toHaveBeenCalled();
    expect(mocks.lifecycle.markFatalFailure).toHaveBeenCalledWith(MESSAGE_ID, 'twilio:failed');
  });

  it('dead-letters when a completed pass includes a permanent failure', async () => {
    const twilio = stubProvider('twilio', {
      success: false,
      error: '[http] twilio responded with status 400',
      isRetryable: false,
      isAmbiguous: false,
    });
    const bird = stubProvider('bird', {
      success: false,
      error: '[http] bird responded with status 503',
      isRetryable: true,
      isAmbiguous: false,
    });
    const mocks = buildMocks([twilio, bird]);
    const processor = buildProcessor(mocks);

    const outcome = await processor.process(job());

    expect(outcome).toEqual({ status: 'dead-letter', reason: 'permanent' });
    expect(mocks.lifecycle.scheduleRetry).not.toHaveBeenCalled();
    expect(mocks.lifecycle.markFatalFailure).toHaveBeenCalledWith(
      MESSAGE_ID,
      'twilio:failed, bird:failed',
    );
  });

  it('dead-letters once the configured retry-round limit is reached', async () => {
    const twilio = stubProvider('twilio', {
      success: false,
      error: '[http] twilio responded with status 503',
      isRetryable: true,
      isAmbiguous: false,
    });
    const mocks = buildMocks([twilio]);
    mocks.lifecycle.beginProcessing.mockResolvedValue({
      outcome: 'started',
      message: processingMessage({ retryRounds: 3 }),
    });
    const processor = buildProcessor(mocks, { PROVIDER_MAX_RETRY_ROUNDS: 3 });

    const outcome = await processor.process(job());

    expect(outcome).toEqual({ status: 'dead-letter', reason: 'rounds-exhausted' });
    expect(mocks.lifecycle.scheduleRetry).not.toHaveBeenCalled();
  });

  it('does not replay the provider after a network rejection escapes the provider call', async () => {
    const twilio = stubProvider('twilio');
    twilio.sendSms.mockRejectedValueOnce(new Error('network unavailable'));
    const mocks = buildMocks([twilio]);
    mocks.lifecycle.beginProcessing
      .mockResolvedValueOnce({ outcome: 'started', message: processingMessage() })
      .mockResolvedValueOnce({ outcome: 'not_startable' });
    const processor = buildProcessor(mocks);

    await expect(processor.process(job())).rejects.toThrow('network unavailable');
    const replay = await processor.process(job());

    expect(replay).toEqual({ status: 'skipped' });
    expect(twilio.sendSms).toHaveBeenCalledTimes(1);
  });

  it('does not replay the provider after result persistence fails following an invocation', async () => {
    const twilio = stubProvider('twilio', {
      success: true,
      providerMessageId: 'twilio-message-1',
      isRetryable: false,
    });
    const mocks = buildMocks([twilio]);
    mocks.lifecycle.finalizeProviderAttempt.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    mocks.lifecycle.beginProcessing
      .mockResolvedValueOnce({ outcome: 'started', message: processingMessage() })
      .mockResolvedValueOnce({ outcome: 'not_startable' });
    const processor = buildProcessor(mocks);

    await expect(processor.process(job())).rejects.toThrow('database unavailable');
    const replay = await processor.process(job());

    expect(replay).toEqual({ status: 'skipped' });
    expect(twilio.sendSms).toHaveBeenCalledTimes(1);
  });

  it('acks without side effects when a reservation is lost to a concurrent operation', async () => {
    const twilio = stubProvider('twilio');
    const mocks = buildMocks([twilio]);
    mocks.lifecycle.reserveProviderAttempt.mockResolvedValueOnce({ outcome: 'not_reservable' });
    const processor = buildProcessor(mocks);

    const outcome = await processor.process(job());

    expect(outcome).toEqual({ status: 'skipped' });
    expect(twilio.sendSms).not.toHaveBeenCalled();
  });
});
