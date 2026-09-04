import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import { SmsLifecycleRepository } from '../../database/sms-lifecycle.repository';
import {
  DEFAULT_OUTBOX_RELAY_BATCH_SIZE,
  DEFAULT_OUTBOX_RELAY_INTERVAL_MS,
  SMS_DISPATCH_QUEUE,
  SMS_DLQ_QUEUE,
  SmsDispatchJobData,
} from './queue.constants';

/**
 * Transactional-outbox bridge. On a fixed interval it drains unpublished outbox events
 * and enqueues a deterministic `sms-dispatch` job per event, then marks the event
 * published. This decouples the write path (which only appends an outbox row inside the
 * same transaction as the message) from Redis availability: an event that fails to
 * enqueue stays unpublished and is retried on the next tick (reconciliation).
 *
 * `@nestjs/schedule` is intentionally not a dependency, so the loop is a plain
 * `setInterval` started in `onModuleInit` and cleared in `onModuleDestroy`.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectQueue(SMS_DISPATCH_QUEUE) private readonly dispatchQueue: Queue<SmsDispatchJobData>,
    @InjectQueue(SMS_DLQ_QUEUE) private readonly deadLetterQueue: Queue<SmsDispatchJobData>,
    private readonly lifecycle: SmsLifecycleRepository,
    configService: ConfigService,
  ) {
    this.intervalMs = readPositiveInt(
      configService.get('OUTBOX_RELAY_INTERVAL_MS'),
      DEFAULT_OUTBOX_RELAY_INTERVAL_MS,
    );
    this.batchSize = readPositiveInt(
      configService.get('OUTBOX_RELAY_BATCH_SIZE'),
      DEFAULT_OUTBOX_RELAY_BATCH_SIZE,
    );
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Do not keep the event loop alive solely for the relay timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Drain one batch of unpublished outbox events. Guarded against overlapping runs so a
   * slow tick cannot stack up behind the interval.
   */
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.relayOnce();
    } catch (error) {
      this.logger.error(`OUTBOX_RELAY_TICK_FAILED ${describeError(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async relayOnce(): Promise<void> {
    const events = await this.lifecycle.fetchUnpublishedOutbox(this.batchSize);

    for (const event of events) {
      try {
        const job = queueJobFor(event, this.dispatchQueue, this.deadLetterQueue);
        await job.queue.add(
          job.name,
          { messageId: job.messageId },
          { jobId: event.id, ...job.options },
        );
        await this.lifecycle.markOutboxPublished(event.id);
      } catch (error) {
        const description = describeError(error);
        this.logger.warn(`OUTBOX_PUBLISH_FAILED outboxEventId=${event.id} ${description}`);
        await this.lifecycle.recordOutboxPublishFailure(event.id, description);
      }
    }
  }
}

function queueJobFor(
  event: { eventType: string; aggregateId: string; payload: unknown },
  dispatchQueue: Queue<SmsDispatchJobData>,
  deadLetterQueue: Queue<SmsDispatchJobData>,
): {
  queue: Queue<SmsDispatchJobData>;
  name: 'dispatch' | 'retry' | 'dead-letter' | 'requeue';
  messageId: string;
  options: { delay?: number };
} {
  const payload = readDispatchPayload(event.payload, event.aggregateId);

  if (event.eventType === 'SMS_RETRY_SCHEDULED') {
    if (payload.delayMs === undefined) {
      throw new Error(`Retry outbox event ${event.aggregateId} is missing delayMs`);
    }
    return {
      queue: dispatchQueue,
      name: 'retry',
      messageId: payload.messageId,
      options: { delay: payload.delayMs },
    };
  }

  if (event.eventType === 'SMS_MESSAGE_QUEUED') {
    return { queue: dispatchQueue, name: 'dispatch', messageId: payload.messageId, options: {} };
  }

  if (event.eventType === 'SMS_DEAD_LETTERED') {
    return {
      queue: deadLetterQueue,
      name: 'dead-letter',
      messageId: payload.messageId,
      options: {},
    };
  }

  if (event.eventType === 'SMS_REQUEUED') {
    return { queue: dispatchQueue, name: 'requeue', messageId: payload.messageId, options: {} };
  }

  throw new Error(`Unsupported outbox event type ${event.eventType}`);
}

function readDispatchPayload(
  payload: unknown,
  aggregateId: string,
): {
  messageId: string;
  delayMs?: number;
} {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`Outbox event ${aggregateId} has an invalid payload`);
  }
  const { messageId, delayMs } = payload as Record<string, unknown>;
  if (typeof messageId !== 'string') {
    throw new Error(`Outbox event ${aggregateId} is missing messageId`);
  }
  if (
    delayMs !== undefined &&
    (typeof delayMs !== 'number' || !Number.isInteger(delayMs) || delayMs < 0)
  ) {
    throw new Error(`Outbox event ${aggregateId} has an invalid delayMs`);
  }
  return delayMs === undefined ? { messageId } : { messageId, delayMs };
}

function readPositiveInt(raw: unknown, fallback: number): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
