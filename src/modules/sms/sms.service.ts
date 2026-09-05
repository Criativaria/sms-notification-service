import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EncryptionService } from '../../common/crypto/encryption.service';
import { SmsPersistenceRepository } from '../../database/sms-persistence.repository';
import { maskBody, maskPhone } from '../../observability/masking';
import { SendSmsDto } from './dto/send-sms.dto';

const defaultMaxMessageLength = 160;
const defaultIdempotencyTtlHours = 24;

export interface AcceptedSmsResult {
  messageId: string;
  status: string;
  createdAt: string;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  constructor(
    private readonly configService: ConfigService,
    private readonly encryptionService: EncryptionService,
    private readonly repository: SmsPersistenceRepository,
  ) {}

  async acceptMessage(
    idempotencyKey: string | undefined,
    body: SendSmsDto,
  ): Promise<AcceptedSmsResult> {
    const trimmedKey = idempotencyKey?.trim();
    if (!trimmedKey) {
      throw new BadRequestException('X-Idempotency-Key header is required');
    }

    // The message-length limit is configurable; class-validator decorators are
    // static, so the configured limit is enforced here against ConfigService.
    const maxMessageLength = this.configService.get<number>(
      'MAX_MESSAGE_LENGTH',
      defaultMaxMessageLength,
    );
    if (body.message.length > maxMessageLength) {
      throw new BadRequestException(`message must be at most ${maxMessageLength} characters`);
    }
    if (body.metadata !== undefined && !isBoundedMetadata(body.metadata)) {
      throw new BadRequestException('metadata exceeds supported size or complexity limits');
    }

    const encryptedMessage = this.encryptionService.encrypt(body.message);

    const idempotencyTtlHours = this.configService.get<number>(
      'IDEMPOTENCY_TTL_HOURS',
      defaultIdempotencyTtlHours,
    );

    const { created, message } = await this.repository.createOrGetMessage(
      {
        idempotencyKey: trimmedKey,
        recipientPhone: body.to,
        encryptedMessage,
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      },
      new Date(),
      idempotencyTtlHours,
    );

    if (created) {
      this.logger.log({
        event: 'MESSAGE_QUEUED',
        messageId: message.id,
        recipient: maskPhone(body.to),
        message: maskBody(body.message),
      });
    }

    return {
      messageId: message.id,
      status: message.status,
      createdAt: message.createdAt.toISOString(),
    };
  }
}

function isBoundedMetadata(value: Record<string, unknown>): boolean {
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 4096) {
      return false;
    }
  } catch {
    return false;
  }

  let keyCount = 0;
  const inspect = (item: unknown, depth: number): boolean => {
    if (depth > 4 || item === null || ['string', 'number', 'boolean'].includes(typeof item)) {
      return depth <= 4 && (typeof item !== 'string' || item.length <= 256);
    }
    if (Array.isArray(item)) {
      return item.every((entry) => inspect(entry, depth + 1));
    }
    if (typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) {
      return false;
    }
    return Object.entries(item as Record<string, unknown>).every(([key, entry]) => {
      keyCount += 1;
      return (
        keyCount <= 20 &&
        key.length <= 64 &&
        !['__proto__', 'prototype', 'constructor'].includes(key) &&
        inspect(entry, depth + 1)
      );
    });
  };

  return inspect(value, 0);
}
