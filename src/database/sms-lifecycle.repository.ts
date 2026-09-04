import { Injectable } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';
import {
  assertValidTransition,
  InvalidStateTransitionError,
  isSameState,
  isValidTransition,
  type SmsStatus,
} from './sms-state-machine';

/**
 * PII-safe projection of an SMS message. Deliberately excludes `recipientPhone` and
 * `encryptedMessage` so no lifecycle result ever surfaces a phone number or a body.
 */
export interface LifecycleSmsMessage {
  id: string;
  status: SmsStatus;
  selectedProvider: string | null;
  providerMessageId: string | null;
  lastError: string | null;
  deliveryAttempts: number;
  retryRounds: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UnpublishedOutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  retryCount: number;
  createdAt: Date;
}

export type BeginProcessingResult =
  { outcome: 'started'; message: LifecycleSmsMessage } | { outcome: 'not_startable' };

export type ReserveProviderAttemptResult =
  { outcome: 'reserved'; attemptId: string } | { outcome: 'not_reservable' };

/**
 * `isAmbiguous` and `isRetryable` are supplied explicitly by the caller (derived from the
 * provider's `SendSmsResult`) rather than inferred from `outcome`, so a definitive failure
 * (a clean HTTP error response) and an ambiguous one (timeout / no response) are never
 * conflated: only an ambiguous outcome may leave the message parked in
 * `AWAITING_PROVIDER_RESULT` for audited resolution.
 */
export type FinalizeProviderAttemptInput =
  | { outcome: 'ACCEPTED'; providerMessageId: string }
  | { outcome: 'FAILED'; isAmbiguous: boolean; isRetryable: boolean; errorMessage: string };

export type ResolveTwilioAttemptInput =
  | { resolution: 'KNOWN_SID'; providerMessageId: string }
  | { resolution: 'UNDELIVERED'; evidenceCode: 'TWILIO_UNDELIVERED_CONFIRMED' };

export type ResolveTwilioAttemptResult =
  | { outcome: 'resolved'; message: LifecycleSmsMessage }
  | { outcome: 'already_resolved'; message: LifecycleSmsMessage }
  | { outcome: 'not_found' }
  | { outcome: 'not_awaiting_provider_result'; currentStatus: SmsStatus }
  | { outcome: 'invalid_attempt' }
  | { outcome: 'conflict' };

export class InvalidTwilioResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTwilioResolutionError';
  }
}

export type ApplyDeliveryReportResult =
  | { outcome: 'applied'; message: LifecycleSmsMessage }
  | { outcome: 'duplicate'; message: LifecycleSmsMessage }
  | { outcome: 'not_found' }
  | { outcome: 'invalid_transition'; currentStatus: SmsStatus };

export type ResetForRequeueResult =
  | { outcome: 'requeued'; message: LifecycleSmsMessage }
  | { outcome: 'not_found' }
  | { outcome: 'not_fatal'; currentStatus: SmsStatus };

export type PermanentProviderFailureStatus = 'REJECTED' | 'UNDELIVERED';
export type DeliveryTerminalStatus = 'DELIVERED' | 'UNDELIVERED' | 'REJECTED';

export interface ScheduleRetryOptions {
  incrementRound: boolean;
  delayMs: number;
  lastError?: string;
}

export interface ApplyDeliveryReportInput {
  providerMessageId: string;
  terminalStatus: DeliveryTerminalStatus;
  /** Optional provider-side event id; accepted for signature stability, not persisted. */
  providerEventId?: string;
}

/** Thrown when a targeted message does not exist. Contains only the id, never PII. */
export class SmsMessageNotFoundError extends Error {
  readonly messageId: string;

  constructor(messageId: string) {
    super(`SMS message ${messageId} not found`);
    this.name = 'SmsMessageNotFoundError';
    this.messageId = messageId;
  }
}

/**
 * Thrown when an optimistic-concurrency guarded update matches zero rows because the
 * status changed between read and write (another worker won the race).
 */
export class SmsConcurrentModificationError extends Error {
  readonly messageId: string;
  readonly expected: SmsStatus;
  readonly to: SmsStatus;

  constructor(messageId: string, expected: SmsStatus, to: SmsStatus) {
    super(
      `SMS message ${messageId} changed concurrently; expected ${expected} for transition to ${to}`,
    );
    this.name = 'SmsConcurrentModificationError';
    this.messageId = messageId;
    this.expected = expected;
    this.to = to;
  }
}

const lifecycleSelect = {
  id: true,
  status: true,
  selectedProvider: true,
  providerMessageId: true,
  lastError: true,
  deliveryAttempts: true,
  retryRounds: true,
  createdAt: true,
  updatedAt: true,
} as const;

type StatusUpdateData = Record<string, unknown>;
interface OutboxIntent {
  eventType: string;
  payload: Prisma.InputJsonObject;
}

/**
 * Shared lifecycle seam consumed by both the queue worker and the webhooks module.
 *
 * Every status change is guarded by the state machine and applied inside a transaction
 * with an optimistic-concurrency `where` clause on the current status, so a resumed or
 * duplicated job can never double-advance a message.
 */
@Injectable()
export class SmsLifecycleRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- Outbox relay ---------------------------------------------------------

  async fetchUnpublishedOutbox(limit: number): Promise<UnpublishedOutboxEvent[]> {
    const events = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        id: true,
        aggregateType: true,
        aggregateId: true,
        eventType: true,
        payload: true,
        retryCount: true,
        createdAt: true,
      },
    });

    return events;
  }

  async markOutboxPublished(outboxEventId: string, now = new Date()): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: outboxEventId },
      data: { publishedAt: now },
    });
  }

  async recordOutboxPublishFailure(outboxEventId: string, error: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: outboxEventId },
      data: { retryCount: { increment: 1 }, lastError: error },
    });
  }

  // --- Worker transitions ---------------------------------------------------

  /**
   * Deliberately narrower than `sourceStatesOf('PROCESSING')`: a fresh job pickup may only
   * start from `QUEUED` or `RETRY_SCHEDULED`. `AWAITING_PROVIDER_RESULT` is also a valid
   * predecessor of `PROCESSING` in the state machine (the internal release performed by
   * {@link finalizeProviderAttempt} on a definitive failure), but a message parked there
   * holds an outstanding reservation and must never be re-claimable through this entry
   * point — doing so would defeat the reservation and risk a duplicate provider call.
   */
  private static readonly BEGIN_PROCESSING_FROM: SmsStatus[] = ['QUEUED', 'RETRY_SCHEDULED'];

  async beginProcessing(messageId: string): Promise<BeginProcessingResult> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.smsMessage.updateMany({
        where: { id: messageId, status: { in: SmsLifecycleRepository.BEGIN_PROCESSING_FROM } },
        data: { status: 'PROCESSING' },
      });

      if (claimed.count === 0) {
        return { outcome: 'not_startable' as const };
      }

      const message = await this.readLifecycle(tx, messageId);
      return { outcome: 'started' as const, message };
    });
  }

  /**
   * Establishes the durable boundary immediately before a provider invocation. A replay can
   * never pass this point: once reserved, the message is no longer startable by a worker.
   */
  async reserveProviderAttempt(
    messageId: string,
    providerName: string,
  ): Promise<ReserveProviderAttemptResult> {
    return this.prisma.$transaction(async (tx) => {
      const reserved = await tx.smsMessage.updateMany({
        where: { id: messageId, status: 'PROCESSING' },
        data: {
          status: 'AWAITING_PROVIDER_RESULT',
          selectedProvider: providerName,
          deliveryAttempts: { increment: 1 },
        },
      });

      if (reserved.count === 0) {
        return { outcome: 'not_reservable' as const };
      }

      const attempt = await (
        tx as unknown as {
          smsAttempt: { create(args: unknown): Promise<{ id: string }> };
        }
      ).smsAttempt.create({
        data: {
          smsMessageId: messageId,
          provider: providerName,
          outcome: 'RESERVED',
          isRetryable: false,
          isAmbiguous: true,
        },
      });

      return { outcome: 'reserved' as const, attemptId: attempt.id };
    });
  }

  /**
   * Records the observed provider result against its reservation.
   *
   * - `ACCEPTED` advances the message to `SENT`.
   * - A `FAILED` result with `isAmbiguous: true` (timeout / no response) leaves the message
   *   parked in `AWAITING_PROVIDER_RESULT`: the outcome is unsafe to replay automatically and
   *   requires audited operator resolution or a provider callback.
   * - A `FAILED` result with `isAmbiguous: false` (a clean provider error response) releases
   *   the reservation back to `PROCESSING`, since we know definitively the provider did not
   *   accept the message and it is safe for the worker to try the next configured provider or
   *   schedule a retry round.
   */
  async finalizeProviderAttempt(
    messageId: string,
    attemptId: string,
    input: FinalizeProviderAttemptInput,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const smsAttempt = (
        tx as unknown as {
          smsAttempt: { updateMany(args: unknown): Promise<{ count: number }> };
        }
      ).smsAttempt;
      const isAmbiguous = input.outcome === 'FAILED' && input.isAmbiguous;
      const finalized = await smsAttempt.updateMany({
        where: { id: attemptId, smsMessageId: messageId, outcome: 'RESERVED' },
        data: {
          outcome: input.outcome,
          isRetryable: input.outcome === 'FAILED' ? input.isRetryable : false,
          isAmbiguous,
          ...(input.outcome === 'ACCEPTED'
            ? { providerMessageId: input.providerMessageId }
            : { errorMessage: input.errorMessage }),
        },
      });

      if (finalized.count === 0) {
        throw new SmsConcurrentModificationError(messageId, 'AWAITING_PROVIDER_RESULT', 'SENT');
      }

      if (input.outcome === 'ACCEPTED') {
        const sent = await tx.smsMessage.updateMany({
          where: { id: messageId, status: 'AWAITING_PROVIDER_RESULT' },
          data: { status: 'SENT', providerMessageId: input.providerMessageId },
        });

        if (sent.count === 0) {
          throw new SmsConcurrentModificationError(messageId, 'AWAITING_PROVIDER_RESULT', 'SENT');
        }
        return;
      }

      if (isAmbiguous) {
        // Stays in AWAITING_PROVIDER_RESULT: never auto-retried, never auto-failed-over.
        return;
      }

      const released = await tx.smsMessage.updateMany({
        where: { id: messageId, status: 'AWAITING_PROVIDER_RESULT' },
        data: { status: 'PROCESSING' },
      });

      if (released.count === 0) {
        throw new SmsConcurrentModificationError(
          messageId,
          'AWAITING_PROVIDER_RESULT',
          'PROCESSING',
        );
      }
    });
  }

  /**
   * Resolves an ambiguous Twilio invocation without dispatching or publishing work. The audit
   * row is immutable and unique per attempt, making an identical repeat safe while rejecting a
   * different decision for the same provider call.
   */
  async resolveTwilioAttempt(
    messageId: string,
    attemptId: string,
    input: ResolveTwilioAttemptInput,
  ): Promise<ResolveTwilioAttemptResult> {
    assertValidTwilioResolution(input);

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.smsMessage.findUnique({
        where: { id: messageId },
        select: { status: true },
      });
      if (!current) {
        return { outcome: 'not_found' as const };
      }

      const resolutionStore = (
        tx as unknown as {
          smsAttemptResolution: {
            findUnique(args: unknown): Promise<unknown>;
            create(args: unknown): Promise<unknown>;
          };
        }
      ).smsAttemptResolution;
      const existing = (await resolutionStore.findUnique({
        where: { smsAttemptId: attemptId },
        select: { resolution: true, providerMessageId: true, evidenceCode: true },
      })) as {
        resolution: ResolveTwilioAttemptInput['resolution'];
        providerMessageId: string | null;
        evidenceCode: string | null;
      } | null;

      if (existing) {
        if (matchesResolution(existing, input)) {
          return {
            outcome: 'already_resolved' as const,
            message: await this.readLifecycle(tx, messageId),
          };
        }
        return { outcome: 'conflict' as const };
      }

      if (current.status !== 'AWAITING_PROVIDER_RESULT') {
        return { outcome: 'not_awaiting_provider_result' as const, currentStatus: current.status };
      }

      const attempt = await (
        tx as unknown as {
          smsAttempt: { findUnique(args: unknown): Promise<unknown> };
        }
      ).smsAttempt.findUnique({
        where: { id: attemptId },
        select: { smsMessageId: true, provider: true, isAmbiguous: true },
      });
      const twilioAttempt = attempt as {
        smsMessageId: string;
        provider: string;
        isAmbiguous: boolean;
      } | null;
      if (
        !twilioAttempt ||
        twilioAttempt.smsMessageId !== messageId ||
        twilioAttempt.provider !== 'twilio' ||
        !twilioAttempt.isAmbiguous
      ) {
        return { outcome: 'invalid_attempt' as const };
      }

      const targetStatus = input.resolution === 'KNOWN_SID' ? 'SENT' : 'UNDELIVERED';
      const updated = await tx.smsMessage.updateMany({
        where: { id: messageId, status: 'AWAITING_PROVIDER_RESULT' },
        data:
          input.resolution === 'KNOWN_SID'
            ? { status: targetStatus, providerMessageId: input.providerMessageId }
            : { status: targetStatus, lastError: `Resolved as undelivered: ${input.evidenceCode}` },
      });
      if (updated.count === 0) {
        const concurrent = (await resolutionStore.findUnique({
          where: { smsAttemptId: attemptId },
          select: { resolution: true, providerMessageId: true, evidenceCode: true },
        })) as typeof existing;
        return concurrent && matchesResolution(concurrent, input)
          ? {
              outcome: 'already_resolved' as const,
              message: await this.readLifecycle(tx, messageId),
            }
          : { outcome: 'conflict' as const };
      }

      await resolutionStore.create({
        data: {
          smsMessageId: messageId,
          smsAttemptId: attemptId,
          resolution: input.resolution,
          providerMessageId: input.resolution === 'KNOWN_SID' ? input.providerMessageId : null,
          evidenceCode: input.resolution === 'UNDELIVERED' ? input.evidenceCode : null,
        },
      });

      return { outcome: 'resolved' as const, message: await this.readLifecycle(tx, messageId) };
    });
  }

  async scheduleRetry(messageId: string, opts: ScheduleRetryOptions): Promise<LifecycleSmsMessage> {
    const data: StatusUpdateData = { deliveryAttempts: { increment: 1 } };
    if (opts.incrementRound) {
      data.retryRounds = { increment: 1 };
    }
    if (opts.lastError !== undefined) {
      data.lastError = opts.lastError;
    }

    return this.guardedTransition(messageId, 'RETRY_SCHEDULED', data, {
      eventType: 'SMS_RETRY_SCHEDULED',
      payload: { messageId, delayMs: opts.delayMs },
    });
  }

  async markPermanentProviderFailure(
    messageId: string,
    status: PermanentProviderFailureStatus,
    lastError: string,
  ): Promise<LifecycleSmsMessage> {
    return this.guardedTransition(messageId, status, { lastError });
  }

  async markFatalFailure(messageId: string, lastError: string): Promise<LifecycleSmsMessage> {
    return this.guardedTransition(
      messageId,
      'FATAL_FAILURE',
      { lastError },
      {
        eventType: 'SMS_DEAD_LETTERED',
        payload: { messageId },
      },
    );
  }

  /**
   * Administrative override for DLQ requeue. `FATAL_FAILURE` is terminal in the normal
   * state machine, so this deliberately bypasses the transition guard to move a
   * dead-lettered message back to `RETRY_SCHEDULED` and restore a full retry budget
   * (`retryRounds` reset to 0). It is only reachable from the private-network DLQ endpoint.
   */
  async resetForRequeue(messageId: string): Promise<ResetForRequeueResult> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.smsMessage.findUnique({
        where: { id: messageId },
        select: { status: true },
      });

      if (!current) {
        return { outcome: 'not_found' as const };
      }

      if (current.status !== 'FATAL_FAILURE') {
        return { outcome: 'not_fatal' as const, currentStatus: current.status };
      }

      const updated = await tx.smsMessage.updateMany({
        where: { id: messageId, status: 'FATAL_FAILURE' },
        data: { status: 'RETRY_SCHEDULED', retryRounds: 0, lastError: null },
      });

      if (updated.count === 0) {
        return { outcome: 'not_fatal' as const, currentStatus: current.status };
      }

      await tx.outboxEvent.create({
        data: {
          aggregateType: 'SMS_MESSAGE',
          aggregateId: messageId,
          eventType: 'SMS_REQUEUED',
          payload: { messageId },
        },
      });

      const message = await this.readLifecycle(tx, messageId);
      return { outcome: 'requeued' as const, message };
    });
  }

  // --- Webhook transition ---------------------------------------------------

  async applyDeliveryReport(input: ApplyDeliveryReportInput): Promise<ApplyDeliveryReportResult> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.smsMessage.findFirst({
        where: { providerMessageId: input.providerMessageId },
        select: { id: true, status: true },
      });

      if (!current) {
        return { outcome: 'not_found' as const };
      }

      const currentStatus = current.status;

      if (isSameState(currentStatus, input.terminalStatus)) {
        const message = await this.readLifecycle(tx, current.id);
        return { outcome: 'duplicate' as const, message };
      }

      if (!isValidTransition(currentStatus, input.terminalStatus)) {
        return { outcome: 'invalid_transition' as const, currentStatus };
      }

      const updated = await tx.smsMessage.updateMany({
        where: { id: current.id, status: currentStatus },
        data: { status: input.terminalStatus },
      });

      if (updated.count === 0) {
        // Lost the race; the row is no longer in the status we validated against.
        return { outcome: 'invalid_transition' as const, currentStatus };
      }

      const message = await this.readLifecycle(tx, current.id);
      return { outcome: 'applied' as const, message };
    });
  }

  // --- Internals ------------------------------------------------------------

  private async guardedTransition(
    messageId: string,
    to: SmsStatus,
    data: StatusUpdateData,
    outboxIntent?: OutboxIntent,
  ): Promise<LifecycleSmsMessage> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.smsMessage.findUnique({
        where: { id: messageId },
        select: { status: true },
      });

      if (!current) {
        throw new SmsMessageNotFoundError(messageId);
      }

      const currentStatus = current.status;
      assertValidTransition(currentStatus, to);

      const updated = await tx.smsMessage.updateMany({
        where: { id: messageId, status: currentStatus },
        data: { ...data, status: to },
      });

      if (updated.count === 0) {
        throw new SmsConcurrentModificationError(messageId, currentStatus, to);
      }

      if (outboxIntent) {
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'SMS_MESSAGE',
            aggregateId: messageId,
            eventType: outboxIntent.eventType,
            payload: outboxIntent.payload,
          },
        });
      }

      return this.readLifecycle(tx, messageId);
    });
  }

  private async readLifecycle(
    tx: { smsMessage: { findUnique(args: unknown): Promise<unknown> } },
    messageId: string,
  ): Promise<LifecycleSmsMessage> {
    const message = await tx.smsMessage.findUnique({
      where: { id: messageId },
      select: lifecycleSelect,
    });

    if (!message) {
      throw new SmsMessageNotFoundError(messageId);
    }

    return message as LifecycleSmsMessage;
  }
}

function assertValidTwilioResolution(input: ResolveTwilioAttemptInput): void {
  if (input.resolution === 'KNOWN_SID' && !/^SM[0-9a-f]{32}$/i.test(input.providerMessageId)) {
    throw new InvalidTwilioResolutionError('providerMessageId must be a valid Twilio SM SID');
  }
}

function matchesResolution(
  existing: {
    resolution: ResolveTwilioAttemptInput['resolution'];
    providerMessageId: string | null;
    evidenceCode: string | null;
  },
  input: ResolveTwilioAttemptInput,
): boolean {
  return (
    existing.resolution === input.resolution &&
    existing.providerMessageId ===
      (input.resolution === 'KNOWN_SID' ? input.providerMessageId : null) &&
    existing.evidenceCode === (input.resolution === 'UNDELIVERED' ? input.evidenceCode : null)
  );
}

export { InvalidStateTransitionError };
