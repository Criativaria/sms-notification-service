import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';

import { EncryptionService } from '../../common/crypto/encryption.service';
import { PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { SmsLifecycleRepository } from '../../database/sms-lifecycle.repository';
import { SmsPersistenceRepository } from '../../database/sms-persistence.repository';
import { ProviderFactory } from '../providers/provider.factory';
import { ISmsProvider, SendSmsResult } from '../providers/interfaces/sms-provider.interface';
import { DlqController } from './dlq.controller';
import { OutboxRelayService } from './outbox-relay.service';
import { SmsProcessor } from './sms.processor';
import {
  backoffDelayMs,
  SMS_DISPATCH_QUEUE,
  SMS_DLQ_QUEUE,
  SmsDispatchJobData,
} from './queue.constants';

/**
 * Integration coverage for the reliable-delivery pipeline against LIVE Redis (BullMQ) and
 * LIVE PostgreSQL (to-do.md Section 8). It exercises the real seams that own retries,
 * exponential backoff, dead-lettering and DLQ requeue:
 *
 *   - the dispatch worker's transient-failure handling (`SmsProcessor`),
 *   - the retry-scheduling / backoff seam (`SmsLifecycleRepository.scheduleRetry` +
 *     `OutboxRelayService` enqueuing a delayed retry job),
 *   - exhaustion → FATAL_FAILURE → DLQ (`markFatalFailure` + relay routing to `sms-dlq`),
 *   - DLQ requeue via the private-network controller (idempotent, audited).
 *
 * SMS providers are replaced with a controllable {@link ISmsProvider} double so
 * transient-vs-permanent outcomes are deterministic. Backoff delays are supplied
 * explicitly with a tiny base so the suite stays fast. Cleanup is scoped to the rows and
 * jobs each test creates (delete-by-id + remove-by-job-id); no table is truncated and Redis
 * is never flushed.
 */
const defaultConfig = () => new ConfigService({ PROVIDER_MAX_RETRY_ROUNDS: 3 });

describe('SMS dispatch reliability (integration, live PostgreSQL and Redis)', () => {
  let prisma: PrismaService;
  let client: PrismaClient;
  let persistence: SmsPersistenceRepository;
  let lifecycle: SmsLifecycleRepository;
  let encryption: EncryptionService;
  let dispatchQueue: Queue<SmsDispatchJobData>;
  let deadLetterQueue: Queue<SmsDispatchJobData>;
  let relay: OutboxRelayService;
  let dlqController: DlqController;

  const createdMessageIds: string[] = [];

  /** Tiny backoff base so a "real" exponential delay stays in the millisecond range. */
  const TINY_BACKOFF_BASE_MS = 5;

  function fakeProvider(name: string, result: SendSmsResult): ISmsProvider {
    return { providerName: name, sendSms: () => Promise.resolve(result) };
  }

  /** A `ProviderFactory` stand-in that always resolves `twilio` to the supplied double. */
  function providerFactoryWith(provider: ISmsProvider): ProviderFactory {
    return {
      getProvider: (requested: string) =>
        requested === provider.providerName ? provider : undefined,
      getOrderedProviders: () => [provider],
    } as unknown as ProviderFactory;
  }

  async function createQueuedMessage(): Promise<string> {
    const result = await persistence.createOrGetMessage({
      idempotencyKey: `sms-processor-int-${Date.now()}-${randomUUID()}`,
      recipientPhone: '+14155552671',
      encryptedMessage: encryption.encrypt('Integration reliability body'),
      metadata: { source: 'sms-processor-integration-test' },
    });
    createdMessageIds.push(result.message.id);
    return result.message.id;
  }

  /** Drive the message from QUEUED to PROCESSING, the only source state for a retry/DLQ move. */
  async function moveToProcessing(messageId: string): Promise<void> {
    const begin = await lifecycle.beginProcessing(messageId);
    expect(begin.outcome).toBe('started');
  }

  function jobFor(messageId: string): Job<SmsDispatchJobData> {
    return { data: { messageId } } as Job<SmsDispatchJobData>;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    client = prisma;
    persistence = new SmsPersistenceRepository(
      prisma as unknown as ConstructorParameters<typeof SmsPersistenceRepository>[0],
    );
    lifecycle = new SmsLifecycleRepository(prisma);
    encryption = new EncryptionService(
      new ConfigService({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }),
    );
    dispatchQueue = new Queue<SmsDispatchJobData>(SMS_DISPATCH_QUEUE, {
      connection: { url: process.env.REDIS_URL },
    });
    deadLetterQueue = new Queue<SmsDispatchJobData>(SMS_DLQ_QUEUE, {
      connection: { url: process.env.REDIS_URL },
    });
    // Large interval + no onModuleInit: the relay timer never fires; ticks are driven manually.
    relay = new OutboxRelayService(
      dispatchQueue,
      deadLetterQueue,
      lifecycle,
      new ConfigService({ OUTBOX_RELAY_INTERVAL_MS: 60_000, OUTBOX_RELAY_BATCH_SIZE: 25 }),
    );
    dlqController = new DlqController(lifecycle);
  });

  afterEach(async () => {
    jest.restoreAllMocks();

    const messageIds = createdMessageIds.splice(0);
    if (messageIds.length === 0) {
      return;
    }

    // Remove any jobs the relay enqueued for these messages from BOTH queues (job id == outbox
    // event id), then delete only the rows these tests created.
    const events = await client.outboxEvent.findMany({
      where: { aggregateId: { in: messageIds } },
      select: { id: true },
    });
    await Promise.all(
      events.flatMap((event) => [
        dispatchQueue.remove(event.id).catch(() => undefined),
        deadLetterQueue.remove(event.id).catch(() => undefined),
      ]),
    );

    await client.outboxEvent.deleteMany({ where: { aggregateId: { in: messageIds } } });
    await client.smsIdempotencyKey.deleteMany({ where: { smsMessageId: { in: messageIds } } });
    await client.smsAttemptResolution.deleteMany({ where: { smsMessageId: { in: messageIds } } });
    await client.smsAttempt.deleteMany({ where: { smsMessageId: { in: messageIds } } });
    await client.smsMessage.deleteMany({ where: { id: { in: messageIds } } });
  });

  afterAll(async () => {
    await dispatchQueue.close();
    await deadLetterQueue.close();
    await prisma.$disconnect();
  });

  describe('transient provider failure', () => {
    it('durably records an ambiguous timeout without re-invoking the provider or failing over', async () => {
      const messageId = await createQueuedMessage();
      const processor = new SmsProcessor(
        lifecycle,
        providerFactoryWith(
          fakeProvider('twilio', {
            success: false,
            error: '[timeout] twilio request timed out',
            isRetryable: true,
            isAmbiguous: true,
          }),
        ),
        encryption,
        prisma,
        defaultConfig(),
      );

      const outcome = await processor.process(jobFor(messageId));

      // An ambiguous outcome must never trigger an automatic retry or failover: it stays
      // parked in AWAITING_PROVIDER_RESULT for audited operator resolution.
      expect(outcome).toEqual({ status: 'awaiting-provider-result' });

      const message = await client.smsMessage.findUniqueOrThrow({ where: { id: messageId } });
      expect(message.status).toBe('AWAITING_PROVIDER_RESULT');
      expect(message.selectedProvider).toBe('twilio');
      expect(message.deliveryAttempts).toBe(1);

      const attempts = await client.smsAttempt.findMany({ where: { smsMessageId: messageId } });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        provider: 'twilio',
        outcome: 'FAILED',
        isAmbiguous: true,
      });
    });

    it('fails over to the next provider on a definitive retryable failure within the same pass', async () => {
      const messageId = await createQueuedMessage();
      const twilio = fakeProvider('twilio', {
        success: false,
        error: '[http] twilio responded with status 503',
        isRetryable: true,
        isAmbiguous: false,
      });
      const bird = fakeProvider('bird', {
        success: true,
        providerMessageId: 'bird-message-1',
        isRetryable: false,
      });
      const processor = new SmsProcessor(
        lifecycle,
        {
          getProvider: (name: string) => (name === 'twilio' ? twilio : bird),
          getOrderedProviders: () => [twilio, bird],
        } as unknown as ProviderFactory,
        encryption,
        prisma,
        defaultConfig(),
      );

      const outcome = await processor.process(jobFor(messageId));

      expect(outcome).toEqual({ status: 'sent', provider: 'bird' });

      const message = await client.smsMessage.findUniqueOrThrow({ where: { id: messageId } });
      expect(message.status).toBe('SENT');
      expect(message.providerMessageId).toBe('bird-message-1');
      expect(message.selectedProvider).toBe('bird');

      const attempts = await client.smsAttempt.findMany({
        where: { smsMessageId: messageId },
        orderBy: { createdAt: 'asc' },
      });
      expect(attempts.map((a) => [a.provider, a.outcome, a.isAmbiguous])).toEqual([
        ['twilio', 'FAILED', false],
        ['bird', 'ACCEPTED', false],
      ]);
    });

    it('schedules a retry round from the worker when every provider fails definitively and transiently', async () => {
      const messageId = await createQueuedMessage();
      const twilio = fakeProvider('twilio', {
        success: false,
        error: '[http] twilio responded with status 503',
        isRetryable: true,
        isAmbiguous: false,
      });
      const bird = fakeProvider('bird', {
        success: false,
        error: '[http] bird responded with status 429',
        isRetryable: true,
        isAmbiguous: false,
      });
      const processor = new SmsProcessor(
        lifecycle,
        {
          getProvider: () => undefined,
          getOrderedProviders: () => [twilio, bird],
        } as unknown as ProviderFactory,
        encryption,
        prisma,
        defaultConfig(),
      );

      const outcome = await processor.process(jobFor(messageId));

      expect(outcome).toEqual({ status: 'retry-scheduled' });

      const message = await client.smsMessage.findUniqueOrThrow({ where: { id: messageId } });
      expect(message.status).toBe('RETRY_SCHEDULED');
      expect(message.retryRounds).toBe(1);

      const retryEvent = await client.outboxEvent.findFirstOrThrow({
        where: { aggregateId: messageId, eventType: 'SMS_RETRY_SCHEDULED' },
      });
      expect(retryEvent.publishedAt).toBeNull();
    });

    it('schedules a backed-off retry and the relay enqueues a delayed dispatch job', async () => {
      const messageId = await createQueuedMessage();
      await moveToProcessing(messageId);

      const delayMs = backoffDelayMs(0, TINY_BACKOFF_BASE_MS);
      const scheduled = await lifecycle.scheduleRetry(messageId, {
        incrementRound: true,
        delayMs,
        lastError: '[timeout] all providers failed transiently',
      });

      expect(scheduled.status).toBe('RETRY_SCHEDULED');
      expect(scheduled.retryRounds).toBe(1);

      const retryEvent = await client.outboxEvent.findFirstOrThrow({
        where: { aggregateId: messageId, eventType: 'SMS_RETRY_SCHEDULED' },
      });
      expect(retryEvent.payload).toEqual({ messageId, delayMs });
      expect(retryEvent.publishedAt).toBeNull();

      await relay.tick();

      const publishedRetryEvent = await client.outboxEvent.findUniqueOrThrow({
        where: { id: retryEvent.id },
      });
      expect(publishedRetryEvent.publishedAt).toBeInstanceOf(Date);

      const retryJob = await dispatchQueue.getJob(retryEvent.id);
      expect(retryJob?.name).toBe('retry');
      expect(retryJob?.data).toEqual({ messageId });
      // Backoff is carried as the BullMQ job delay.
      expect(retryJob?.opts.delay).toBe(delayMs);
    });

    it('applies exponential backoff per round', () => {
      expect(backoffDelayMs(0, TINY_BACKOFF_BASE_MS)).toBe(TINY_BACKOFF_BASE_MS);
      expect(backoffDelayMs(1, TINY_BACKOFF_BASE_MS)).toBe(TINY_BACKOFF_BASE_MS * 2);
      expect(backoffDelayMs(2, TINY_BACKOFF_BASE_MS)).toBe(TINY_BACKOFF_BASE_MS * 4);
    });
  });

  describe('exhaustion', () => {
    it('moves an exhausted message to FATAL_FAILURE and the relay routes it to the DLQ', async () => {
      const messageId = await createQueuedMessage();
      await moveToProcessing(messageId);

      const failed = await lifecycle.markFatalFailure(
        messageId,
        'All providers failed transiently for all retry rounds',
      );
      expect(failed.status).toBe('FATAL_FAILURE');

      const deadLetterEvent = await client.outboxEvent.findFirstOrThrow({
        where: { aggregateId: messageId, eventType: 'SMS_DEAD_LETTERED' },
      });
      expect(deadLetterEvent.payload).toEqual({ messageId });

      await relay.tick();

      const dlqJob = await deadLetterQueue.getJob(deadLetterEvent.id);
      expect(dlqJob?.name).toBe('dead-letter');
      expect(dlqJob?.data).toEqual({ messageId });
      // The dead-letter job must land on the DLQ, never back on the dispatch queue.
      expect(await dispatchQueue.getJob(deadLetterEvent.id)).toBeUndefined();
    });
  });

  describe('DLQ requeue', () => {
    async function deadLetter(messageId: string): Promise<void> {
      await moveToProcessing(messageId);
      await lifecycle.markFatalFailure(messageId, 'exhausted for requeue test');
    }

    it('requeues a FATAL_FAILURE message back to RETRY_SCHEDULED with an audited outbox record', async () => {
      const messageId = await createQueuedMessage();
      await deadLetter(messageId);

      const response = await dlqController.requeue(messageId);
      expect(response).toEqual({ messageId, status: 'requeued' });

      const message = await client.smsMessage.findUniqueOrThrow({ where: { id: messageId } });
      expect(message.status).toBe('RETRY_SCHEDULED');
      expect(message.retryRounds).toBe(0);
      expect(message.lastError).toBeNull();

      const requeueEvents = await client.outboxEvent.findMany({
        where: { aggregateId: messageId, eventType: 'SMS_REQUEUED' },
      });
      expect(requeueEvents).toHaveLength(1);
      expect(requeueEvents[0]?.payload).toEqual({ messageId });

      await relay.tick();

      const requeueJob = await dispatchQueue.getJob(requeueEvents[0]!.id);
      expect(requeueJob?.name).toBe('requeue');
      expect(requeueJob?.data).toEqual({ messageId });
    });

    it('is idempotent: a second requeue is rejected and writes no second audit record', async () => {
      const messageId = await createQueuedMessage();
      await deadLetter(messageId);

      await dlqController.requeue(messageId);

      // The message is now RETRY_SCHEDULED (no longer FATAL_FAILURE), so a replayed requeue
      // must be refused and must not double-process.
      await expect(dlqController.requeue(messageId)).rejects.toBeInstanceOf(ConflictException);

      const requeueEvents = await client.outboxEvent.findMany({
        where: { aggregateId: messageId, eventType: 'SMS_REQUEUED' },
      });
      expect(requeueEvents).toHaveLength(1);
    });
  });

  describe('per-provider rate limiting', () => {
    it('constructs the dispatch worker with the configured 10 TPS limiter', () => {
      const workerOptions = Reflect.getMetadata('bullmq:worker_metadata', SmsProcessor) as
        { limiter?: { max: number; duration: number } } | undefined;

      expect(workerOptions?.limiter).toEqual({ max: 10, duration: 1000 });
    });
  });
});
