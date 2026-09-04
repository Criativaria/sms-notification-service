import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EncryptionService } from '../../common/crypto/encryption.service';
import { SmsPersistenceRepository } from '../../database/sms-persistence.repository';
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

    const encryptedMessage = this.encryptionService.encrypt(body.message);

    const idempotencyTtlHours = this.configService.get<number>(
      'IDEMPOTENCY_TTL_HOURS',
      defaultIdempotencyTtlHours,
    );

    const { message } = await this.repository.createOrGetMessage(
      {
        idempotencyKey: trimmedKey,
        recipientPhone: body.to,
        encryptedMessage,
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      },
      new Date(),
      idempotencyTtlHours,
    );

    return {
      messageId: message.id,
      status: message.status,
      createdAt: message.createdAt.toISOString(),
    };
  }
}
