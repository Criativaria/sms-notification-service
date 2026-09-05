import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EncryptionService } from '../../common/crypto/encryption.service';
import {
  PersistedSmsMessage,
  SmsPersistenceRepository,
} from '../../database/sms-persistence.repository';
import { SendSmsDto } from './dto/send-sms.dto';
import { SmsService } from './sms.service';

const persistedMessage: PersistedSmsMessage = {
  id: '77b9aa41-4ba3-4785-b593-7d0265416cde',
  idempotencyKey: 'request-123',
  recipientPhone: '+14155552671',
  encryptedMessage: 'ciphertext',
  metadata: null,
  status: 'QUEUED',
  selectedProvider: null,
  providerMessageId: null,
  lastError: null,
  deliveryAttempts: 0,
  retryRounds: 0,
  retentionExpiresAt: new Date('2026-12-03T12:00:00.000Z'),
  createdAt: new Date('2026-09-04T12:00:00.000Z'),
  updatedAt: new Date('2026-09-04T12:00:00.000Z'),
};

function createService(overrides?: { maxMessageLength?: number; created?: boolean }) {
  const get = jest.fn((_key: string, fallback: number) => overrides?.maxMessageLength ?? fallback);
  const encrypt = jest.fn(() => 'encrypted-token');
  const createOrGetMessage = jest.fn(() =>
    Promise.resolve({ created: overrides?.created ?? true, message: persistedMessage }),
  );

  const configService = { get } as unknown as ConfigService;
  const encryptionService = { encrypt } as unknown as EncryptionService;
  const repository = { createOrGetMessage } as unknown as SmsPersistenceRepository;

  const service = new SmsService(configService, encryptionService, repository);
  return { service, encrypt, createOrGetMessage };
}

function body(overrides?: Partial<SendSmsDto>): SendSmsDto {
  return { to: '+14155552671', message: 'hello', ...overrides };
}

describe('SmsService', () => {
  it('encrypts the body and returns the accepted queued result', async () => {
    const { service, encrypt, createOrGetMessage } = createService();

    const result = await service.acceptMessage('request-123', body({ message: 'secret text' }));

    expect(encrypt).toHaveBeenCalledWith('secret text');
    expect(createOrGetMessage).toHaveBeenCalledWith(
      {
        idempotencyKey: 'request-123',
        recipientPhone: '+14155552671',
        encryptedMessage: 'encrypted-token',
      },
      expect.any(Date),
      24,
    );
    expect(result).toEqual({
      messageId: persistedMessage.id,
      status: 'QUEUED',
      createdAt: '2026-09-04T12:00:00.000Z',
    });
  });

  it('logs a masked MESSAGE_QUEUED event only when it creates a message', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const { service } = createService();

    await service.acceptMessage('request-123', body({ message: 'secret text' }));

    expect(log).toHaveBeenCalledWith({
      event: 'MESSAGE_QUEUED',
      messageId: persistedMessage.id,
      recipient: '+1415***2671',
      message: '[body len=11]',
    });
    log.mockRestore();
  });

  it('forwards optional metadata to the repository', async () => {
    const { service, createOrGetMessage } = createService();

    await service.acceptMessage('request-123', body({ metadata: { purpose: 'OTP' } }));

    expect(createOrGetMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { purpose: 'OTP' } }),
      expect.any(Date),
      24,
    );
  });

  it('rejects oversized metadata before encryption or persistence', async () => {
    const { service, encrypt, createOrGetMessage } = createService();

    await expect(
      service.acceptMessage('request-123', body({ metadata: { value: 'x'.repeat(4097) } })),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(encrypt).not.toHaveBeenCalled();
    expect(createOrGetMessage).not.toHaveBeenCalled();
  });

  it('returns the existing record for a duplicate idempotency key without new work', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const { service, createOrGetMessage } = createService({ created: false });

    const result = await service.acceptMessage('request-123', body());

    expect(result.messageId).toBe(persistedMessage.id);
    expect(result.status).toBe('QUEUED');
    expect(createOrGetMessage).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'MESSAGE_QUEUED' }));
    log.mockRestore();
  });

  it('rejects a missing idempotency key with 400', async () => {
    const { service } = createService();

    await expect(service.acceptMessage(undefined, body())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.acceptMessage('   ', body())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces the configurable message-length limit', async () => {
    const { service, encrypt } = createService({ maxMessageLength: 5 });

    await expect(
      service.acceptMessage('request-123', body({ message: 'too long' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(encrypt).not.toHaveBeenCalled();
  });
});
