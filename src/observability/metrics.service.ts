import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaService } from '../database/prisma.service';
import {
  SMS_DISPATCH_QUEUE,
  SMS_DLQ_QUEUE,
  SmsDispatchJobData,
} from '../modules/queue/queue.constants';

interface QueueGauges {
  waiting: number;
  delayed: number;
  active: number;
}

export interface MetricsSnapshot {
  gauges: {
    dispatchQueue: QueueGauges;
    outboxUnpublished: number;
    deadLetterQueue: QueueGauges;
  };
  counters: {
    providerAttempts: number;
    providerErrors: number;
    failovers: number;
    deadLetters: number;
    deadLetterNotifications: number;
    processingLatency: { count: number; totalMs: number; averageMs: number };
  };
}

@Injectable()
export class MetricsService {
  private providerAttempts = 0;
  private providerErrors = 0;
  private failovers = 0;
  private deadLetters = 0;
  private deadLetterNotifications = 0;
  private processingLatencyCount = 0;
  private processingLatencyTotalMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(SMS_DISPATCH_QUEUE) private readonly dispatchQueue: Queue<SmsDispatchJobData>,
    @InjectQueue(SMS_DLQ_QUEUE) private readonly deadLetterQueue: Queue<SmsDispatchJobData>,
  ) {}

  recordProviderAttempt(): void {
    this.providerAttempts += 1;
  }

  recordProviderError(): void {
    this.providerErrors += 1;
  }

  recordFailover(): void {
    this.failovers += 1;
  }

  recordDeadLetter(): void {
    this.deadLetters += 1;
  }

  recordDeadLetterNotification(): void {
    this.deadLetterNotifications += 1;
  }

  recordProcessingLatency(durationMs: number): void {
    this.processingLatencyCount += 1;
    this.processingLatencyTotalMs += durationMs;
  }

  async snapshot(): Promise<MetricsSnapshot> {
    const [dispatchCounts, deadLetterCounts, outboxUnpublished] = await Promise.all([
      this.dispatchQueue.getJobCounts('waiting', 'delayed', 'active'),
      this.deadLetterQueue.getJobCounts('waiting', 'delayed', 'active'),
      this.prisma.outboxEvent.count({ where: { publishedAt: null } }),
    ]);
    const averageMs =
      this.processingLatencyCount === 0
        ? 0
        : this.processingLatencyTotalMs / this.processingLatencyCount;

    return {
      gauges: {
        dispatchQueue: queueGauges(dispatchCounts),
        outboxUnpublished,
        deadLetterQueue: queueGauges(deadLetterCounts),
      },
      counters: {
        providerAttempts: this.providerAttempts,
        providerErrors: this.providerErrors,
        failovers: this.failovers,
        deadLetters: this.deadLetters,
        deadLetterNotifications: this.deadLetterNotifications,
        processingLatency: {
          count: this.processingLatencyCount,
          totalMs: this.processingLatencyTotalMs,
          averageMs,
        },
      },
    };
  }
}

function queueGauges(counts: Record<string, number>): QueueGauges {
  return { waiting: counts.waiting ?? 0, delayed: counts.delayed ?? 0, active: counts.active ?? 0 };
}
