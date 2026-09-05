import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { SmsLifecycleRepository } from '../../database/sms-lifecycle.repository';
import { SmsPersistenceRepository } from '../../database/sms-persistence.repository';
import { OutboxRelayService } from './outbox-relay.service';
import {
  SMS_DISPATCH_QUEUE,
  SMS_DLQ_QUEUE,
  SMS_MAINTENANCE_QUEUE,
  SmsDispatchJobData,
} from './queue.constants';

describe('OutboxRelayService (integration, live PostgreSQL and Redis)', () => {
  let prisma: PrismaService;
  let persistence: SmsPersistenceRepository;
  let lifecycle: SmsLifecycleRepository;
  let dispatchQueue: Queue<SmsDispatchJobData>;
  let deadLetterQueue: Queue<SmsDispatchJobData>;
  let maintenanceQueue: Queue<SmsDispatchJobData>;
  let relay: OutboxRelayService;
  const createdMessageIds: string[] = [];
  const createdJobIds: string[] = [];

  async function createMessage(): Promise<string> {
    const result = await persistence.createOrGetMessage({
      idempotencyKey: `outbox-relay-int-${Date.now()}-${randomUUID()}`,
      recipientPhone: '+14155552671',
      encryptedMessage: 'encrypted-payload',
      metadata: { source: 'outbox-relay-integration-test' },
    });
    createdMessageIds.push(result.message.id);
    const outboxEvent = await (prisma as unknown as PrismaClient).outboxEvent.findFirstOrThrow({
      where: { aggregateId: result.message.id, eventType: 'SMS_MESSAGE_QUEUED' },
    });
    createdJobIds.push(`${result.message.id}#${outboxEvent.id}`);
    return result.message.id;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    persistence = new SmsPersistenceRepository(
      prisma as unknown as ConstructorParameters<typeof SmsPersistenceRepository>[0],
    );
    lifecycle = new SmsLifecycleRepository(prisma);
    dispatchQueue = new Queue<SmsDispatchJobData>(SMS_DISPATCH_QUEUE, {
      connection: { url: process.env.REDIS_URL },
    });
    deadLetterQueue = new Queue<SmsDispatchJobData>(SMS_DLQ_QUEUE, {
      connection: { url: process.env.REDIS_URL },
    });
    maintenanceQueue = new Queue<SmsDispatchJobData>(SMS_MAINTENANCE_QUEUE, {
      connection: { url: process.env.REDIS_URL },
    });
    relay = new OutboxRelayService(
      dispatchQueue,
      deadLetterQueue,
      maintenanceQueue,
      lifecycle,
      new ConfigService({ OUTBOX_RELAY_INTERVAL_MS: 60_000, OUTBOX_RELAY_BATCH_SIZE: 10 }),
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(createdJobIds.splice(0).map((jobId) => dispatchQueue.remove(jobId)));

    const messageIds = createdMessageIds.splice(0);
    if (messageIds.length > 0) {
      const client = prisma as unknown as PrismaClient;
      await client.outboxEvent.deleteMany({ where: { aggregateId: { in: messageIds } } });
      await client.smsIdempotencyKey.deleteMany({ where: { smsMessageId: { in: messageIds } } });
      await client.smsAttempt.deleteMany({ where: { smsMessageId: { in: messageIds } } });
      await client.smsMessage.deleteMany({ where: { id: { in: messageIds } } });
    }
  });

  afterAll(async () => {
    await dispatchQueue.close();
    await deadLetterQueue.close();
    await maintenanceQueue.close();
    await prisma.$disconnect();
  });

  it('publishes an atomically created outbox event once with its deterministic job id', async () => {
    const messageId = await createMessage();
    const add = jest.spyOn(dispatchQueue, 'add');

    await relay.tick();
    await relay.tick();

    const client = prisma as unknown as PrismaClient;
    const outboxEvents = await client.outboxEvent.findMany({
      where: { aggregateId: messageId },
    });
    const expectedJobId = `${messageId}#${outboxEvents[0]!.id}`;
    const job = await dispatchQueue.getJob(expectedJobId);

    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]).toMatchObject({
      aggregateType: 'SMS_MESSAGE',
      aggregateId: messageId,
      eventType: 'SMS_MESSAGE_QUEUED',
      payload: { messageId },
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      'dispatch',
      { messageId },
      {
        jobId: expectedJobId,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    expect(job?.id).toBe(expectedJobId);
    expect(job?.data).toEqual({ messageId });
    expect(outboxEvents[0]?.publishedAt).toBeInstanceOf(Date);
    expect(outboxEvents[0]?.retryCount).toBe(0);
    expect(outboxEvents[0]?.lastError).toBeNull();
  });

  it('records a failed publish and publishes the same event on a later tick', async () => {
    const messageId = await createMessage();
    const add = jest
      .spyOn(dispatchQueue, 'add')
      .mockRejectedValueOnce(new Error('simulated Redis publish failure'));

    await relay.tick();

    const client = prisma as unknown as PrismaClient;
    const failedEvent = await client.outboxEvent.findFirstOrThrow({
      where: { aggregateId: messageId },
    });
    expect(failedEvent.publishedAt).toBeNull();
    expect(failedEvent.retryCount).toBe(1);
    expect(failedEvent.lastError).toBe('simulated Redis publish failure');

    await relay.tick();

    const publishedEvent = await client.outboxEvent.findFirstOrThrow({
      where: { aggregateId: messageId },
    });
    const expectedJobId = `${messageId}#${publishedEvent.id}`;
    const job = await dispatchQueue.getJob(expectedJobId);
    expect(add).toHaveBeenCalledTimes(2);
    expect(job?.id).toBe(expectedJobId);
    expect(job?.data).toEqual({ messageId });
    expect(publishedEvent.publishedAt).toBeInstanceOf(Date);
    expect(publishedEvent.retryCount).toBe(1);
    expect(publishedEvent.lastError).toBe('simulated Redis publish failure');
  });

  it('recovers when enqueue succeeds but marking the outbox event published fails', async () => {
    const messageId = await createMessage();
    const add = jest.spyOn(dispatchQueue, 'add');
    const markOutboxPublished = jest
      .spyOn(lifecycle, 'markOutboxPublished')
      .mockRejectedValueOnce(new Error('simulated post-enqueue crash'));

    await relay.tick();

    const client = prisma as unknown as PrismaClient;
    const unpublishedEvent = await client.outboxEvent.findFirstOrThrow({
      where: { aggregateId: messageId },
    });
    expect(unpublishedEvent.publishedAt).toBeNull();
    expect(unpublishedEvent.retryCount).toBe(1);
    expect(unpublishedEvent.lastError).toBe('simulated post-enqueue crash');
    const outboxEvent = await client.outboxEvent.findFirstOrThrow({
      where: { aggregateId: messageId },
    });
    const expectedJobId = `${messageId}#${outboxEvent.id}`;
    expect(await dispatchQueue.getJob(expectedJobId)).toMatchObject({
      id: expectedJobId,
      data: { messageId },
    });

    await relay.tick();

    const publishedEvent = await client.outboxEvent.findFirstOrThrow({
      where: { aggregateId: messageId },
    });
    const jobs = await dispatchQueue.getJobs();

    expect(add).toHaveBeenCalledTimes(2);
    expect(markOutboxPublished).toHaveBeenCalledTimes(2);
    expect(jobs.filter((job) => job.id === expectedJobId)).toHaveLength(1);
    expect(publishedEvent.publishedAt).toBeInstanceOf(Date);
    expect(publishedEvent.retryCount).toBe(1);
    expect(publishedEvent.lastError).toBe('simulated post-enqueue crash');
  });
});
