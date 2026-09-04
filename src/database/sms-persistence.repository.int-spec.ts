import { randomUUID } from 'node:crypto';

import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';
import { SmsPersistenceRepository, type CreateSmsMessageInput } from './sms-persistence.repository';

describe('SmsPersistenceRepository (integration, live PostgreSQL)', () => {
  let prisma: PrismaService;
  let repository: SmsPersistenceRepository;
  const createdMessageIds: string[] = [];
  const createdIdempotencyKeys: string[] = [];

  function buildInput(overrides: Partial<CreateSmsMessageInput> = {}): CreateSmsMessageInput {
    const idempotencyKey = overrides.idempotencyKey ?? `int-${Date.now()}-${randomUUID()}`;
    createdIdempotencyKeys.push(idempotencyKey);
    return {
      recipientPhone: '+14155552671',
      encryptedMessage: 'encrypted-payload',
      metadata: { source: 'integration-test' },
      ...overrides,
      idempotencyKey,
    };
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    repository = new SmsPersistenceRepository(
      prisma as unknown as ConstructorParameters<typeof SmsPersistenceRepository>[0],
    );
  });

  afterAll(async () => {
    if (createdMessageIds.length > 0) {
      const client = prisma as unknown as PrismaClient;
      await client.outboxEvent.deleteMany({ where: { aggregateId: { in: createdMessageIds } } });
      await client.smsIdempotencyKey.deleteMany({
        where: { smsMessageId: { in: createdMessageIds } },
      });
      await client.smsAttempt.deleteMany({ where: { smsMessageId: { in: createdMessageIds } } });
      await client.smsMessage.deleteMany({ where: { id: { in: createdMessageIds } } });
    }
    await prisma.$disconnect();
  });

  it('atomically creates exactly one message, outbox event, and idempotency key for a fresh key', async () => {
    const input = buildInput();
    const client = prisma as unknown as PrismaClient;

    const result = await repository.createOrGetMessage(input);
    createdMessageIds.push(result.message.id);

    expect(result.created).toBe(true);
    expect(result.message.status).toBe('QUEUED');
    expect(result.message.idempotencyKey).toBe(input.idempotencyKey);

    const messageRows = await client.smsMessage.findMany({
      where: { idempotencyKey: input.idempotencyKey },
    });
    expect(messageRows).toHaveLength(1);
    const [messageRow] = messageRows;
    expect(messageRow!.id).toBe(result.message.id);
    expect(messageRow!.status).toBe('QUEUED');

    const outboxRows = await client.outboxEvent.findMany({
      where: { aggregateId: result.message.id },
    });
    expect(outboxRows).toHaveLength(1);
    const [outboxRow] = outboxRows;
    expect(outboxRow!.aggregateType).toBe('SMS_MESSAGE');
    expect(outboxRow!.eventType).toBe('SMS_MESSAGE_QUEUED');
    expect(outboxRow!.publishedAt).toBeNull();

    const idempotencyRows = await client.smsIdempotencyKey.findMany({
      where: { key: input.idempotencyKey },
    });
    expect(idempotencyRows).toHaveLength(1);
    const [idempotencyRow] = idempotencyRows;
    expect(idempotencyRow!.smsMessageId).toBe(result.message.id);
  });

  it('returns the same message and writes no new rows when the same key is reused within TTL', async () => {
    const input = buildInput();
    const client = prisma as unknown as PrismaClient;

    const first = await repository.createOrGetMessage(input);
    createdMessageIds.push(first.message.id);
    expect(first.created).toBe(true);

    const countRows = async () => ({
      messages: await client.smsMessage.count({ where: { idempotencyKey: input.idempotencyKey } }),
      outbox: await client.outboxEvent.count({ where: { aggregateId: first.message.id } }),
      idempotency: await client.smsIdempotencyKey.count({ where: { key: input.idempotencyKey } }),
    });

    const before = await countRows();
    expect(before).toEqual({ messages: 1, outbox: 1, idempotency: 1 });

    const second = await repository.createOrGetMessage(input);

    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);

    const after = await countRows();
    expect(after).toEqual(before);
  });
});
