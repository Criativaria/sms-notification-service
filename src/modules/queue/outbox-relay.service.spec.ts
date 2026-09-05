import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import {
  SmsLifecycleRepository,
  UnpublishedOutboxEvent,
} from '../../database/sms-lifecycle.repository';
import { OutboxRelayService } from './outbox-relay.service';
import { SmsDispatchJobData } from './queue.constants';

interface Mocks {
  lifecycle: {
    fetchUnpublishedOutbox: jest.Mock;
    markOutboxPublished: jest.Mock;
    recordOutboxPublishFailure: jest.Mock;
  };
  dispatchQueue: { add: jest.Mock };
  deadLetterQueue: { add: jest.Mock };
  maintenanceQueue: { add: jest.Mock };
  config: { get: jest.Mock };
}

function event(overrides: Partial<UnpublishedOutboxEvent> = {}): UnpublishedOutboxEvent {
  return {
    id: 'outbox-1',
    aggregateType: 'SMS_MESSAGE',
    aggregateId: 'msg-1',
    eventType: 'SMS_MESSAGE_QUEUED',
    payload: { messageId: 'msg-1' },
    retryCount: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function buildMocks(): Mocks {
  return {
    lifecycle: {
      fetchUnpublishedOutbox: jest.fn().mockResolvedValue([]),
      markOutboxPublished: jest.fn().mockResolvedValue(undefined),
      recordOutboxPublishFailure: jest.fn().mockResolvedValue(undefined),
    },
    dispatchQueue: { add: jest.fn().mockResolvedValue(undefined) },
    deadLetterQueue: { add: jest.fn().mockResolvedValue(undefined) },
    maintenanceQueue: { add: jest.fn().mockResolvedValue(undefined) },
    config: { get: jest.fn().mockReturnValue(undefined) },
  };
}

function buildRelay(mocks: Mocks): OutboxRelayService {
  return new OutboxRelayService(
    mocks.dispatchQueue as unknown as Queue<SmsDispatchJobData>,
    mocks.deadLetterQueue as unknown as Queue<SmsDispatchJobData>,
    mocks.maintenanceQueue as unknown as Queue<SmsDispatchJobData>,
    mocks.lifecycle as unknown as SmsLifecycleRepository,
    mocks.config as unknown as ConfigService,
  );
}

describe('OutboxRelayService', () => {
  it('enqueues each unpublished event with a deterministic jobId and marks it published', async () => {
    const mocks = buildMocks();
    mocks.lifecycle.fetchUnpublishedOutbox.mockResolvedValue([
      event({ id: 'outbox-1', aggregateId: 'msg-1' }),
      event({ id: 'outbox-2', aggregateId: 'msg-2', payload: { messageId: 'msg-2' } }),
    ]);
    const relay = buildRelay(mocks);

    await relay.tick();

    expect(mocks.dispatchQueue.add).toHaveBeenNthCalledWith(
      1,
      'dispatch',
      { messageId: 'msg-1' },
      { jobId: 'msg-1#outbox-1', removeOnComplete: true, removeOnFail: true },
    );
    expect(mocks.dispatchQueue.add).toHaveBeenNthCalledWith(
      2,
      'dispatch',
      { messageId: 'msg-2' },
      { jobId: 'msg-2#outbox-2', removeOnComplete: true, removeOnFail: true },
    );
    expect(mocks.lifecycle.markOutboxPublished).toHaveBeenCalledWith('outbox-1');
    expect(mocks.lifecycle.markOutboxPublished).toHaveBeenCalledWith('outbox-2');
    expect(mocks.lifecycle.recordOutboxPublishFailure).not.toHaveBeenCalled();
  });

  it('records a publish failure and does not mark published when enqueue throws', async () => {
    const mocks = buildMocks();
    mocks.lifecycle.fetchUnpublishedOutbox.mockResolvedValue([event({ id: 'outbox-1' })]);
    mocks.dispatchQueue.add.mockRejectedValue(new Error('redis unavailable'));
    const relay = buildRelay(mocks);

    await relay.tick();

    expect(mocks.lifecycle.recordOutboxPublishFailure).toHaveBeenCalledWith(
      'outbox-1',
      'redis unavailable',
    );
    expect(mocks.lifecycle.markOutboxPublished).not.toHaveBeenCalled();
  });

  it('routes a retry event to a delayed dispatch job with a message- and event-derived job id', async () => {
    const mocks = buildMocks();
    mocks.lifecycle.fetchUnpublishedOutbox.mockResolvedValue([
      event({
        id: 'outbox-retry-1',
        eventType: 'SMS_RETRY_SCHEDULED',
        payload: { messageId: 'msg-1', delayMs: 2000 },
      }),
    ]);
    const relay = buildRelay(mocks);

    await relay.tick();

    expect(mocks.dispatchQueue.add).toHaveBeenCalledWith(
      'retry',
      { messageId: 'msg-1' },
      { jobId: 'msg-1#outbox-retry-1', delay: 2000, removeOnComplete: true, removeOnFail: true },
    );
    expect(mocks.lifecycle.markOutboxPublished).toHaveBeenCalledWith('outbox-retry-1');
  });

  it('routes an ambiguous-outcome expiry event to one delayed maintenance job', async () => {
    const mocks = buildMocks();
    mocks.lifecycle.fetchUnpublishedOutbox.mockResolvedValue([
      event({
        id: 'outbox-expiry-1',
        eventType: 'SMS_AMBIGUOUS_OUTCOME_EXPIRY_SCHEDULED',
        payload: { messageId: 'msg-1', delayMs: 900000 },
      }),
    ]);
    const relay = buildRelay(mocks);

    await relay.tick();

    expect(mocks.maintenanceQueue.add).toHaveBeenCalledWith(
      'ambiguous-outcome-expiry',
      { messageId: 'msg-1' },
      {
        jobId: 'msg-1#outbox-expiry-1',
        delay: 900000,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    expect(mocks.dispatchQueue.add).not.toHaveBeenCalled();
    expect(mocks.lifecycle.markOutboxPublished).toHaveBeenCalledWith('outbox-expiry-1');
  });

  it('routes a dead-letter event to the DLQ with a message- and event-derived job id', async () => {
    const mocks = buildMocks();
    mocks.lifecycle.fetchUnpublishedOutbox.mockResolvedValue([
      event({ id: 'outbox-dlq-1', eventType: 'SMS_DEAD_LETTERED' }),
    ]);
    const relay = buildRelay(mocks);

    await relay.tick();

    expect(mocks.deadLetterQueue.add).toHaveBeenCalledWith(
      'dead-letter',
      { messageId: 'msg-1' },
      { jobId: 'msg-1#outbox-dlq-1', removeOnComplete: true, removeOnFail: true },
    );
    expect(mocks.dispatchQueue.add).not.toHaveBeenCalled();
    expect(mocks.lifecycle.markOutboxPublished).toHaveBeenCalledWith('outbox-dlq-1');
  });

  it('routes a requeue event to a fresh dispatch job with a message- and event-derived job id', async () => {
    const mocks = buildMocks();
    mocks.lifecycle.fetchUnpublishedOutbox.mockResolvedValue([
      event({ id: 'outbox-requeue-1', eventType: 'SMS_REQUEUED' }),
    ]);
    const relay = buildRelay(mocks);

    await relay.tick();

    expect(mocks.dispatchQueue.add).toHaveBeenCalledWith(
      'requeue',
      { messageId: 'msg-1' },
      { jobId: 'msg-1#outbox-requeue-1', removeOnComplete: true, removeOnFail: true },
    );
    expect(mocks.lifecycle.markOutboxPublished).toHaveBeenCalledWith('outbox-requeue-1');
  });

  it('routes a recovered processing event to a fresh dispatch job', async () => {
    const mocks = buildMocks();
    mocks.lifecycle.fetchUnpublishedOutbox.mockResolvedValue([
      event({ id: 'outbox-recovery-1', eventType: 'SMS_PROCESSING_RECOVERED' }),
    ]);
    const relay = buildRelay(mocks);

    await relay.tick();

    expect(mocks.dispatchQueue.add).toHaveBeenCalledWith(
      'recovered',
      { messageId: 'msg-1' },
      { jobId: 'msg-1#outbox-recovery-1', removeOnComplete: true, removeOnFail: true },
    );
    expect(mocks.lifecycle.markOutboxPublished).toHaveBeenCalledWith('outbox-recovery-1');
  });

  it('is a no-op when there are no unpublished events', async () => {
    const mocks = buildMocks();
    const relay = buildRelay(mocks);

    await relay.tick();

    expect(mocks.dispatchQueue.add).not.toHaveBeenCalled();
  });
});
