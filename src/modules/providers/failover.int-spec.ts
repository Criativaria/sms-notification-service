import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosResponse } from 'axios';
import { Observable, of, throwError } from 'rxjs';

import { SendSmsOptions } from './interfaces/sms-provider.interface';
import { ProviderFactory } from './provider.factory';
import { ProviderManager } from './provider-manager';
import { BirdProvider } from './strategies/bird.provider';
import { TwilioProvider } from './strategies/twilio.provider';

/**
 * Integration coverage for the automatic Twilio-to-Bird failover invariant.
 *
 * This assembles the REAL provider stack — {@link ProviderManager} over the real
 * {@link ProviderFactory}, driven by the configured `SMS_PROVIDER_PRIORITY=twilio,bird`,
 * with real {@link TwilioProvider} and {@link BirdProvider} strategies — and only stubs
 * the lowest seam, the axios HttpService. It therefore exercises the true HTTP-status →
 * retryability classification (via `normalizeProviderError`) end to end, not hand-rolled
 * `SendSmsResult` stubs.
 *
 * Strategy (a) from the brief was chosen over the worker-level strategy (b) because the
 * queue worker (`sms.processor.ts`) calls a single Twilio provider directly and never
 * consumes `ProviderManager`; the same-pass failover invariant lives entirely in
 * `ProviderManager.dispatch()`, which is the smallest real seam that proves it.
 *
 * No network, database, or Redis is touched. No real credentials or phone numbers appear.
 */
describe('Provider failover (integration, real provider stack, stubbed HTTP layer)', () => {
  const options: SendSmsOptions = {
    to: '+15005550006',
    body: 'integration failover check',
    referenceId: 'failover-int-ref',
  };

  let configService: ConfigService;
  let twilioHttp: { post: jest.Mock };
  let birdHttp: { post: jest.Mock };
  let manager: ProviderManager;

  /** Builds a resolved HTTP response Observable for a provider success. */
  function httpSuccess<T>(data: T): Observable<AxiosResponse<T>> {
    return of({ data } as AxiosResponse<T>);
  }

  /** Builds an errored HTTP Observable carrying an axios error with the given status. */
  function httpStatusError(status: number): Observable<never> {
    const error = new AxiosError(
      `Request failed with status code ${status}`,
      'ERR_BAD_RESPONSE',
      undefined,
      undefined,
      { status } as AxiosResponse,
    );
    return throwError(() => error);
  }

  beforeEach(() => {
    // ConfigService with no explicit config falls back to process.env, which the
    // integration setup file populates (SMS_PROVIDER_PRIORITY, provider credentials).
    configService = new ConfigService();

    twilioHttp = { post: jest.fn() };
    birdHttp = { post: jest.fn() };

    const twilio = new TwilioProvider(twilioHttp as unknown as HttpService, configService);
    const bird = new BirdProvider(birdHttp as unknown as HttpService, configService);

    const factory = new ProviderFactory(configService, [twilio, bird]);
    manager = new ProviderManager(factory);
  });

  it('honors the configured twilio,bird priority order', () => {
    // Guards the premise of every assertion below: the pass really starts at Twilio.
    expect(process.env.SMS_PROVIDER_PRIORITY).toBe('twilio,bird');
  });

  it('fails over to Bird after a retryable Twilio failure and returns Bird as the sender', async () => {
    // Twilio: HTTP 503 (retryable server error). Bird: success with a provider message id.
    twilioHttp.post.mockReturnValue(httpStatusError(503));
    birdHttp.post.mockReturnValue(httpSuccess({ id: 'bird-provider-msg-id' }));

    const outcome = await manager.dispatch(options);

    // Delivered via Bird, carrying Bird's provider message id.
    expect(outcome.result.success).toBe(true);
    expect(outcome.providerName).toBe('bird');
    expect(outcome.result.providerMessageId).toBe('bird-provider-msg-id');

    // Twilio was attempted first, then Bird — both attempts are represented, in order.
    expect(twilioHttp.post).toHaveBeenCalledTimes(1);
    expect(birdHttp.post).toHaveBeenCalledTimes(1);
    expect(outcome.attempts.map((attempt) => attempt.providerName)).toEqual(['twilio', 'bird']);

    // The Twilio attempt is a retryable failure; the Bird attempt is the success.
    const twilioAttempt = outcome.attempts[0]!;
    const birdAttempt = outcome.attempts[1]!;
    expect(twilioAttempt.result.success).toBe(false);
    expect(twilioAttempt.result.isRetryable).toBe(true);
    expect(birdAttempt.result.success).toBe(true);
    expect(birdAttempt.result.providerMessageId).toBe('bird-provider-msg-id');
  });

  it('fails over on a 429 Twilio rate-limit as well (rate limit is retryable)', async () => {
    twilioHttp.post.mockReturnValue(httpStatusError(429));
    birdHttp.post.mockReturnValue(httpSuccess({ id: 'bird-after-429' }));

    const outcome = await manager.dispatch(options);

    expect(outcome.result.success).toBe(true);
    expect(outcome.providerName).toBe('bird');
    expect(outcome.result.providerMessageId).toBe('bird-after-429');
    expect(outcome.attempts.map((attempt) => attempt.providerName)).toEqual(['twilio', 'bird']);
  });

  it('surfaces a permanent Twilio 4xx business error as permanent and does not mask it as retryable', async () => {
    // Non-failover guard. A permanent Twilio 400 must not be recovered by the retry loop:
    // even though a lower-priority provider is attempted in the same pass, the aggregate
    // outcome must remain PERMANENT (isRetryable === false) so no exponential-backoff round
    // is ever scheduled. Bird here also fails, transiently, to prove the permanent Twilio
    // signal dominates the later retryable one rather than being overwritten by it.
    twilioHttp.post.mockReturnValue(httpStatusError(400));
    birdHttp.post.mockReturnValue(httpStatusError(503));

    const outcome = await manager.dispatch(options);

    // No provider succeeded, and the surfaced outcome is the permanent Twilio failure.
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.isRetryable).toBe(false);
    expect(outcome.providerName).toBe('twilio');
    expect(outcome.attempts.map((attempt) => attempt.providerName)).toEqual(['twilio', 'bird']);

    const twilioAttempt = outcome.attempts[0]!;
    const birdAttempt = outcome.attempts[1]!;
    expect(twilioAttempt.result.isRetryable).toBe(false);
    expect(birdAttempt.result.isRetryable).toBe(true);
  });
});
