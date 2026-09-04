import { ISmsProvider, SendSmsOptions, SendSmsResult } from './interfaces/sms-provider.interface';
import { ProviderFactory } from './provider.factory';
import { ProviderManager } from './provider-manager';

const options: SendSmsOptions = {
  to: '+14155552671',
  body: 'hello',
  referenceId: 'ref-1',
};

interface StubProvider {
  provider: ISmsProvider;
  getCallCount: () => number;
}

function providerReturning(name: string, result: SendSmsResult): StubProvider {
  let callCount = 0;
  const provider: ISmsProvider = {
    providerName: name,
    sendSms: (): Promise<SendSmsResult> => {
      callCount += 1;
      return Promise.resolve(result);
    },
  };
  return { provider, getCallCount: () => callCount };
}

function managerWith(stubs: StubProvider[]): ProviderManager {
  const providers = stubs.map((stub) => stub.provider);
  const factory = { getOrderedProviders: () => providers } as unknown as ProviderFactory;
  return new ProviderManager(factory);
}

const success: SendSmsResult = { success: true, providerMessageId: 'id-1', isRetryable: false };
const retryable: SendSmsResult = { success: false, error: 'transient', isRetryable: true };
const permanent: SendSmsResult = { success: false, error: 'invalid', isRetryable: false };

describe('ProviderManager', () => {
  it('returns the first provider success without trying the rest', async () => {
    const twilio = providerReturning('twilio', success);
    const bird = providerReturning('bird', success);
    const outcome = await managerWith([twilio, bird]).dispatch(options);

    expect(outcome.result).toEqual(success);
    expect(outcome.providerName).toBe('twilio');
    expect(outcome.attempts).toHaveLength(1);
    expect(bird.getCallCount()).toBe(0);
  });

  it('fails over to the next provider on a retryable failure and stops on success', async () => {
    const twilio = providerReturning('twilio', retryable);
    const bird = providerReturning('bird', success);
    const outcome = await managerWith([twilio, bird]).dispatch(options);

    expect(outcome.result).toEqual(success);
    expect(outcome.providerName).toBe('bird');
    expect(outcome.attempts.map((attempt) => attempt.providerName)).toEqual(['twilio', 'bird']);
  });

  it('continues after a permanent failure when a lower-priority provider succeeds', async () => {
    const twilio = providerReturning('twilio', permanent);
    const bird = providerReturning('bird', success);
    const outcome = await managerWith([twilio, bird]).dispatch(options);

    expect(outcome.result).toEqual(success);
    expect(outcome.providerName).toBe('bird');
    expect(outcome.attempts.map((attempt) => attempt.providerName)).toEqual(['twilio', 'bird']);
    expect(bird.getCallCount()).toBe(1);
  });

  it('returns a permanent aggregate after all providers fail when any attempt is permanent', async () => {
    const twilio = providerReturning('twilio', permanent);
    const bird = providerReturning('bird', retryable);
    const outcome = await managerWith([twilio, bird]).dispatch(options);

    expect(outcome.result).toEqual(permanent);
    expect(outcome.providerName).toBe('twilio');
    expect(outcome.attempts.map((attempt) => attempt.providerName)).toEqual(['twilio', 'bird']);
    expect(bird.getCallCount()).toBe(1);
  });

  it('reports a retryable overall outcome when every provider fails transiently', async () => {
    const twilio = providerReturning('twilio', retryable);
    const bird = providerReturning('bird', retryable);
    const outcome = await managerWith([twilio, bird]).dispatch(options);

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.isRetryable).toBe(true);
    expect(outcome.providerName).toBe('bird');
    expect(outcome.attempts).toHaveLength(2);
  });

  it('returns a permanent no-providers outcome when none are configured', async () => {
    const outcome = await managerWith([]).dispatch(options);

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.isRetryable).toBe(false);
    expect(outcome.attempts).toHaveLength(0);
  });
});
