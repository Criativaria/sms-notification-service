/**
 * Queue names and deterministic job-id helpers for the SMS dispatch pipeline.
 *
 * The dispatch job id is intentionally the message id: the outbox relay may enqueue
 * the same event more than once (at-least-once delivery), and a deterministic id makes
 * BullMQ dedupe those re-adds into a single job.
 */
export const SMS_DISPATCH_QUEUE = 'sms-dispatch';
export const SMS_DLQ_QUEUE = 'sms-dlq';

/** Default outbox relay poll interval, in milliseconds. Overridable via `OUTBOX_RELAY_INTERVAL_MS`. */
export const DEFAULT_OUTBOX_RELAY_INTERVAL_MS = 2000;

/** Default number of unpublished outbox events drained per relay tick. */
export const DEFAULT_OUTBOX_RELAY_BATCH_SIZE = 50;

/** Base delay for exponential retry backoff, in milliseconds. */
export const DEFAULT_RETRY_BACKOFF_BASE_MS = 2000;

/** Deterministic dispatch job id: one message maps to exactly one dispatch job. */
export function dispatchJobId(messageId: string): string {
  return messageId;
}

/**
 * Retry re-enqueue job id. A retry needs a fresh id because the original dispatch job
 * still occupies `dispatchJobId(messageId)` (BullMQ keeps completed ids until cleaned),
 * so re-adding under that id would be a no-op. The lifecycle guard (`beginProcessing`)
 * still prevents any double-advance regardless of how many jobs reference the message.
 */
export function retryJobId(messageId: string, round: number): string {
  return `${messageId}:retry:${round}`;
}

/** Exponential backoff: base * 2^round → 2s, 4s, 8s, ... for base 2000ms. */
export function backoffDelayMs(
  round: number,
  baseMs: number = DEFAULT_RETRY_BACKOFF_BASE_MS,
): number {
  return baseMs * 2 ** round;
}

/** Shape of the payload carried by every `sms-dispatch` and `sms-dlq` job. */
export interface SmsDispatchJobData {
  messageId: string;
}
