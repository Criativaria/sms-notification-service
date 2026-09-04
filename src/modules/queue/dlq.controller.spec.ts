import { ConflictException, NotFoundException } from '@nestjs/common';
import { SmsLifecycleRepository } from '../../database/sms-lifecycle.repository';
import { DlqController } from './dlq.controller';

const MESSAGE_ID = 'msg-1';

interface Mocks {
  lifecycle: { resetForRequeue: jest.Mock };
}

function buildMocks(): Mocks {
  return {
    lifecycle: { resetForRequeue: jest.fn() },
  };
}

function buildController(mocks: Mocks): DlqController {
  return new DlqController(mocks.lifecycle as unknown as SmsLifecycleRepository);
}

describe('DlqController', () => {
  it('resets a FATAL_FAILURE message and leaves relay publication to its outbox intent', async () => {
    const mocks = buildMocks();
    mocks.lifecycle.resetForRequeue.mockResolvedValue({ outcome: 'requeued', message: {} });
    const controller = buildController(mocks);

    const response = await controller.requeue(MESSAGE_ID);

    expect(response).toEqual({ messageId: MESSAGE_ID, status: 'requeued' });
    expect(mocks.lifecycle.resetForRequeue).toHaveBeenCalledWith(MESSAGE_ID);
  });

  it('throws NotFoundException when the message does not exist', async () => {
    const mocks = buildMocks();
    mocks.lifecycle.resetForRequeue.mockResolvedValue({ outcome: 'not_found' });
    const controller = buildController(mocks);

    await expect(controller.requeue(MESSAGE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects requeue for a message that is not FATAL_FAILURE', async () => {
    const mocks = buildMocks();
    mocks.lifecycle.resetForRequeue.mockResolvedValue({
      outcome: 'not_fatal',
      currentStatus: 'SENT',
    });
    const controller = buildController(mocks);

    await expect(controller.requeue(MESSAGE_ID)).rejects.toBeInstanceOf(ConflictException);
  });
});
