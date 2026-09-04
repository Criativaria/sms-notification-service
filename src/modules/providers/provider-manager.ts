import { Injectable } from '@nestjs/common';

import { SendSmsOptions, SendSmsResult } from './interfaces/sms-provider.interface';
import { ProviderFactory } from './provider.factory';

export interface DispatchAttempt {
  providerName: string;
  result: SendSmsResult;
}

export interface DispatchOutcome {
  result: SendSmsResult;
  providerName: string;
  attempts: DispatchAttempt[];
}

/**
 * Orchestrates a single ordered pass over the registered providers.
 *
 * Behaviour per pass:
 * - stop and return on the first success;
 * - stop and return immediately on an ambiguous outcome (timeout / no response) — an
 *   unconfirmed result must never trigger a failover to another provider, since the first
 *   provider may have actually accepted the message;
 * - otherwise continue through every configured provider after a definitive failure.
 *
 * The returned `result` doubles as the overall retryability signal: it is the
 * winning success, the ambiguous attempt that halted the pass, the first permanent
 * failure when no provider succeeded, or the last retryable failure when every provider
 * failed transiently. The round/backoff loop belongs to the queue worker, not here.
 */
@Injectable()
export class ProviderManager {
  constructor(private readonly providerFactory: ProviderFactory) {}

  async dispatch(options: SendSmsOptions): Promise<DispatchOutcome> {
    const providers = this.providerFactory.getOrderedProviders();
    const attempts: DispatchAttempt[] = [];

    for (const provider of providers) {
      const result = await provider.sendSms(options);
      attempts.push({ providerName: provider.providerName, result });

      if (result.success) {
        return { result, providerName: provider.providerName, attempts };
      }

      if (result.isAmbiguous) {
        return { result, providerName: provider.providerName, attempts };
      }
    }

    const permanentAttempt = attempts.find((attempt) => !attempt.result.isRetryable);
    const lastAttempt = attempts[attempts.length - 1];
    const terminalAttempt = permanentAttempt ?? lastAttempt;
    if (terminalAttempt) {
      return {
        result: terminalAttempt.result,
        providerName: terminalAttempt.providerName,
        attempts,
      };
    }

    return {
      result: {
        success: false,
        error: 'No SMS providers are configured',
        isRetryable: false,
      },
      providerName: '',
      attempts,
    };
  }
}
