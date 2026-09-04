import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { SmsMessageStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { incrementRetentionDeleted } from './retention.metrics';

/**
 * Terminal statuses whose records are safe to purge once retention has elapsed.
 *
 * A message is only purged when it has reached a state from which no further lifecycle
 * transition is expected. In-flight states (QUEUED, PROCESSING, RETRY_SCHEDULED) and SENT
 * (still awaiting a provider delivery receipt that will move it to DELIVERED/UNDELIVERED)
 * are deliberately excluded even if `retentionExpiresAt` has passed: purging them would
 * drop work the system still intends to act on, and could race the delivery/webhook path.
 */
const TERMINAL_STATUSES: SmsMessageStatus[] = [
  'DELIVERED',
  'UNDELIVERED',
  'REJECTED',
  'FATAL_FAILURE',
];

const DEFAULT_CLEANUP_INTERVAL_MS = 3_600_000; // 1 hour
const DEFAULT_CLEANUP_BATCH_SIZE = 500;

/**
 * Data-retention cleanup job. On a fixed interval it purges SMS records whose 90-day
 * retention window (`SmsMessage.retentionExpiresAt`) has elapsed, provided the message has
 * reached a terminal state.
 *
 * The child tables (`sms_attempts`, `outbox_events`) hold `onDelete: Restrict` foreign
 * keys to `sms_messages`, so a message row cannot be deleted while those children exist.
 * Each batch therefore deletes children first, then the messages, inside a single
 * `prisma.$transaction` (idempotency keys cascade automatically). Work is done in batches
 * to stay safe on large tables.
 *
 * `@nestjs/schedule` is intentionally not a dependency, so the loop is a plain
 * `setInterval` started in `onModuleInit` and cleared in `onModuleDestroy`, guarded by an
 * in-flight flag so a slow purge cannot stack up behind the interval.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.intervalMs = readPositiveInt(
      configService.get('RETENTION_CLEANUP_INTERVAL_MS'),
      DEFAULT_CLEANUP_INTERVAL_MS,
    );
    this.batchSize = readPositiveInt(
      configService.get('RETENTION_CLEANUP_BATCH_SIZE'),
      DEFAULT_CLEANUP_BATCH_SIZE,
    );
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Do not keep the event loop alive solely for the cleanup timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One scheduled purge cycle. Guarded against overlapping runs so a slow purge on a large
   * table cannot stack up behind the interval, and failures are logged without crashing the
   * timer.
   */
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.purgeExpired();
    } catch (error) {
      this.logger.error(`RETENTION_CLEANUP_FAILED ${describeError(error)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Purge one batch of messages whose retention window has elapsed and that are in a
   * terminal state. Deletes children (`sms_attempts`, `outbox_events`) before the messages
   * inside a transaction to satisfy the `onDelete: Restrict` foreign keys.
   *
   * Emits a structured `RETENTION_CLEANUP` audit log line (deleted count only — never phone
   * numbers or message bodies) and increments the in-module retention counter.
   *
   * @param now Injectable clock for deterministic testing; defaults to the current time.
   * @returns The number of `sms_messages` rows deleted in this run.
   */
  async purgeExpired(now: Date = new Date()): Promise<{ deletedMessages: number }> {
    const deletedMessages = await this.prisma.$transaction(async (tx) => {
      const expired = await tx.smsMessage.findMany({
        where: {
          retentionExpiresAt: { lte: now },
          status: { in: TERMINAL_STATUSES },
        },
        select: { id: true },
        take: this.batchSize,
      });

      const ids = expired.map((row) => row.id);
      if (ids.length === 0) {
        return 0;
      }

      // Children first: both carry onDelete: Restrict foreign keys to sms_messages, so the
      // message rows cannot be removed while these reference them.
      await tx.smsAttempt.deleteMany({ where: { smsMessageId: { in: ids } } });
      await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });

      // Idempotency keys cascade on message delete, so they are not deleted explicitly here.
      const deleted = await tx.smsMessage.deleteMany({ where: { id: { in: ids } } });
      return deleted.count;
    });

    incrementRetentionDeleted(deletedMessages);
    this.logger.log(`RETENTION_CLEANUP deletedMessages=${deletedMessages}`);

    return { deletedMessages };
  }
}

function readPositiveInt(raw: unknown, fallback: number): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
