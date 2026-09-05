import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';

import { EncryptionService } from '../../common/crypto/encryption.service';
import { PrismaService } from '../../database/prisma.service';
import {
  SmsConcurrentModificationError,
  SmsLifecycleRepository,
} from '../../database/sms-lifecycle.repository';
import { ProviderFactory } from '../providers/provider.factory';
import { SendSmsResult } from '../providers/interfaces/sms-provider.interface';
import {
  backoffDelayMs,
  DEFAULT_RETRY_BACKOFF_BASE_MS,
  SMS_DISPATCH_QUEUE,
  SmsDispatchJobData,
} from './queue.constants';
import { ProviderRateLimiter } from './provider-rate-limiter';

export type ProcessOutcome =
  | { status: 'skipped' }
  | { status: 'sent'; provider: string }
  | { status: 'awaiting-provider-result' }
  | { status: 'retry-scheduled' }
  | { status: 'dead-letter'; reason: 'permanent' | 'rounds-exhausted' | 'message-missing' };

interface PassFailure {
  providerName: string;
  isRetryable: boolean;
}

/**
 * BullMQ worker for the `sms-dispatch` queue.
 *
 * Each provider invocation is preceded by a durable reservation
 * ({@link SmsLifecycleRepository.reserveProviderAttempt}) that takes the message out of
 * dispatchability. A replay can therefore never invoke a provider twice for the same
 * attempt, including after a timeout or a crash while persisting the result.
 *
 * A single pass tries the configured providers, in priority order, until one succeeds:
 * - a DEFINITIVE failure (the provider gave a clean response — success or an HTTP error) is
 *   safe to continue past, so the worker releases the reservation and tries the next
 *   provider in the same pass;
 * - an AMBIGUOUS outcome (timeout, network error, or no response) means we do not know
 *   whether the provider accepted the message. The worker stops immediately: it never
 *   fails over to another provider and never schedules an automatic retry, because either
 *   could duplicate a delivery the first provider actually completed. The message stays in
 *   `AWAITING_PROVIDER_RESULT` for audited operator resolution or a provider callback.
 *
 * If every configured provider fails definitively in one pass, the worker schedules an
 * exponential-backoff retry round (only when every failure was retryable and the
 * configured round limit is not exhausted) or moves the message to `FATAL_FAILURE`/DLQ.
 *
 * Concurrency safety comes from {@link SmsLifecycleRepository.beginProcessing} and
 * {@link SmsLifecycleRepository.reserveProviderAttempt}: only one worker can hold a message
 * at a time, so a duplicated or replayed job is a no-op.
 */
@Processor(SMS_DISPATCH_QUEUE)
export class SmsProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsProcessor.name);
  private readonly maxRetryRounds: number;
  private readonly backoffBaseMs: number;
  private readonly ambiguousOutcomeExpiryMs: number;

  constructor(
    private readonly lifecycle: SmsLifecycleRepository,
    private readonly providerFactory: ProviderFactory,
    private readonly encryption: EncryptionService,
    private readonly prisma: PrismaService,
    private readonly providerRateLimiter: ProviderRateLimiter,
    configService: ConfigService,
  ) {
    super();
    this.maxRetryRounds = readPositiveInt(configService.get('PROVIDER_MAX_RETRY_ROUNDS'), 3);
    this.backoffBaseMs = DEFAULT_RETRY_BACKOFF_BASE_MS;
    this.ambiguousOutcomeExpiryMs = readPositiveInt(
      configService.get('AMBIGUOUS_OUTCOME_EXPIRY_MS'),
      900_000,
    );
  }

  async process(job: Job<SmsDispatchJobData>): Promise<ProcessOutcome> {
    return this.processDispatch(job);
  }

  private async processDispatch(job: Job<SmsDispatchJobData>): Promise<ProcessOutcome> {
    const { messageId } = job.data;

    const begin = await this.lifecycle.beginProcessing(messageId);
    if (begin.outcome === 'not_startable') {
      // Already terminal, awaiting a provider result, or claimed by another worker.
      return { status: 'skipped' };
    }

    const row = await this.prisma.smsMessage.findUnique({
      where: { id: messageId },
      select: { recipientPhone: true, encryptedMessage: true },
    });
    if (!row) {
      return this.guardConcurrency(messageId, async () => {
        await this.lifecycle.markFatalFailure(messageId, 'Message row disappeared before dispatch');
        return { status: 'dead-letter', reason: 'message-missing' };
      });
    }

    const body = this.encryption.decrypt(row.encryptedMessage);
    const providers = this.providerFactory.getOrderedProviders();
    const passFailures: PassFailure[] = [];

    for (const provider of providers) {
      const reservation = await this.lifecycle.reserveProviderAttempt(
        messageId,
        provider.providerName,
      );
      if (reservation.outcome === 'not_reservable') {
        // Lost the race: another worker or a concurrent operation already advanced this
        // message (e.g. an administrative requeue). Ack without side effects.
        return { status: 'skipped' };
      }

      await this.providerRateLimiter.acquire(provider.providerName);
      const result = await provider.sendSms({
        to: row.recipientPhone,
        body,
        referenceId: messageId,
      });

      if (result.success && result.providerMessageId?.trim()) {
        await this.lifecycle.finalizeProviderAttempt(messageId, reservation.attemptId, {
          outcome: 'ACCEPTED',
          providerMessageId: result.providerMessageId,
        });
        this.logger.log(`MESSAGE_SENT messageId=${messageId} provider=${provider.providerName}`);
        return { status: 'sent', provider: provider.providerName };
      }

      const { isAmbiguous, isRetryable, errorMessage } = classify(result);

      await this.lifecycle.finalizeProviderAttempt(messageId, reservation.attemptId, {
        outcome: 'FAILED',
        isAmbiguous,
        isRetryable,
        errorMessage,
        ...(isAmbiguous ? { ambiguousOutcomeExpiryMs: this.ambiguousOutcomeExpiryMs } : {}),
      });

      if (isAmbiguous) {
        this.logger.warn(
          `PROVIDER_ATTEMPT_AWAITING_ACTION messageId=${messageId} provider=${provider.providerName}`,
        );
        return { status: 'awaiting-provider-result' };
      }

      this.logger.warn(
        `PROVIDER_ATTEMPT_FAILED messageId=${messageId} provider=${provider.providerName} retryable=${isRetryable}`,
      );
      if (providers.indexOf(provider) < providers.length - 1) {
        this.logger.warn(`PROVIDER_FAILOVER messageId=${messageId} from=${provider.providerName}`);
      }
      passFailures.push({ providerName: provider.providerName, isRetryable });
    }

    // Every configured provider produced a definitive failure this pass (or none are
    // configured). Decide whether another round is worthwhile.
    return this.guardConcurrency(messageId, async () => {
      const allRetryable =
        passFailures.length > 0 && passFailures.every((failure) => failure.isRetryable);
      const currentRound = begin.message.retryRounds;
      const summary = summarizeFailures(passFailures);

      if (allRetryable && currentRound < this.maxRetryRounds) {
        const delayMs = backoffDelayMs(currentRound, this.backoffBaseMs);
        await this.lifecycle.scheduleRetry(messageId, {
          incrementRound: true,
          delayMs,
          lastError: summary,
        });
        this.logger.warn(
          `MESSAGE_RETRY_SCHEDULED messageId=${messageId} round=${currentRound + 1} delayMs=${delayMs}`,
        );
        return { status: 'retry-scheduled' };
      }

      await this.lifecycle.markFatalFailure(messageId, summary);
      this.logger.warn(`MESSAGE_DEAD_LETTERED messageId=${messageId} reason=${summary}`);
      return {
        status: 'dead-letter',
        reason: allRetryable ? 'rounds-exhausted' : 'permanent',
      };
    });
  }

  /**
   * Runs a lifecycle-mutating block, treating a lost optimistic-concurrency race as a
   * benign "another worker already advanced this message" — ack and stop.
   */
  private async guardConcurrency(
    messageId: string,
    block: () => Promise<ProcessOutcome>,
  ): Promise<ProcessOutcome> {
    try {
      return await block();
    } catch (error) {
      if (error instanceof SmsConcurrentModificationError) {
        this.logger.warn(`MESSAGE_CLAIMED_CONCURRENTLY messageId=${messageId}`);
        return { status: 'skipped' };
      }
      throw error;
    }
  }
}

function classify(result: SendSmsResult): {
  isAmbiguous: boolean;
  isRetryable: boolean;
  errorMessage: string;
} {
  if (result.success) {
    // Accepted but missing a provider message id: we cannot durably correlate this send,
    // so treat it the same as an unconfirmed outcome rather than risk a silent duplicate.
    return {
      isAmbiguous: true,
      isRetryable: false,
      errorMessage: 'Provider accepted response did not include a valid message id',
    };
  }

  return {
    isAmbiguous: result.isAmbiguous === true,
    isRetryable: result.isRetryable,
    errorMessage: safeError(result.error),
  };
}

function summarizeFailures(failures: PassFailure[]): string {
  if (failures.length === 0) {
    return 'No SMS providers are configured';
  }
  return failures.map((failure) => `${failure.providerName}:failed`).join(', ');
}

function safeError(error: string | undefined): string {
  return error ?? 'Unknown provider error';
}

function readPositiveInt(raw: unknown, fallback: number): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
