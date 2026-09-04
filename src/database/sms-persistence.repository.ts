import { Inject, Injectable } from '@nestjs/common';

export const SMS_PERSISTENCE_CLIENT = Symbol('SMS_PERSISTENCE_CLIENT');

export interface CreateSmsMessageInput {
  idempotencyKey: string;
  recipientPhone: string;
  encryptedMessage: string;
  metadata?: Record<string, unknown>;
}

export interface PersistedSmsMessage {
  id: string;
  idempotencyKey: string;
  recipientPhone: string;
  encryptedMessage: string;
  metadata: Record<string, unknown> | null;
  status: string;
  selectedProvider: string | null;
  providerMessageId: string | null;
  lastError: string | null;
  deliveryAttempts: number;
  retryRounds: number;
  retentionExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrGetSmsMessageResult {
  created: boolean;
  message: PersistedSmsMessage;
}

export interface RecordProviderAttemptInput {
  smsMessageId: string;
  provider: string;
  providerMessageId?: string;
  outcome: 'ACCEPTED' | 'FAILED' | 'TIMEOUT';
  isRetryable: boolean;
  isAmbiguous: boolean;
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface IdempotencyOwner {
  expiresAt: Date;
  smsMessage: PersistedSmsMessage;
}

export interface SmsPersistenceTransaction {
  smsIdempotencyKey: {
    findUnique(args: unknown): Promise<IdempotencyOwner | null>;
    deleteMany(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
  };
  smsMessage: {
    create(args: unknown): Promise<PersistedSmsMessage>;
  };
  outboxEvent: {
    create(args: unknown): Promise<unknown>;
  };
  smsAttempt: {
    create(args: unknown): Promise<unknown>;
  };
}

export interface SmsPersistenceClient {
  $transaction<T>(callback: (transaction: SmsPersistenceTransaction) => Promise<T>): Promise<T>;
}

const defaultIdempotencyTtlHours = 24;
const retentionLifetimeMilliseconds = 90 * 24 * 60 * 60 * 1000;

@Injectable()
export class SmsPersistenceRepository {
  constructor(@Inject(SMS_PERSISTENCE_CLIENT) private readonly prisma: SmsPersistenceClient) {}

  async createOrGetMessage(
    input: CreateSmsMessageInput,
    now = new Date(),
    idempotencyTtlHours = defaultIdempotencyTtlHours,
  ): Promise<CreateOrGetSmsMessageResult> {
    try {
      return await this.createOrGetMessageInTransaction(input, now, idempotencyTtlHours);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }

      return this.createOrGetMessageInTransaction(input, now, idempotencyTtlHours);
    }
  }

  async recordProviderAttempt(input: RecordProviderAttemptInput): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.smsAttempt.create({
        data: {
          smsMessageId: input.smsMessageId,
          provider: input.provider,
          outcome: input.outcome,
          isRetryable: input.isRetryable,
          isAmbiguous: input.isAmbiguous,
          ...(input.providerMessageId === undefined
            ? {}
            : { providerMessageId: input.providerMessageId }),
          ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
          ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
          ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
        },
      });
    });
  }

  private async createOrGetMessageInTransaction(
    input: CreateSmsMessageInput,
    now: Date,
    idempotencyTtlHours: number,
  ): Promise<CreateOrGetSmsMessageResult> {
    const idempotencyLifetimeMilliseconds = idempotencyTtlHours * 60 * 60 * 1000;
    return this.prisma.$transaction(async (transaction) => {
      const existingOwner = await transaction.smsIdempotencyKey.findUnique({
        where: { key: input.idempotencyKey },
        include: { smsMessage: true },
      });

      if (existingOwner && existingOwner.expiresAt > now) {
        return { created: false, message: existingOwner.smsMessage };
      }

      if (existingOwner) {
        await transaction.smsIdempotencyKey.deleteMany({
          where: { key: input.idempotencyKey, expiresAt: { lte: now } },
        });
      }

      const message = await transaction.smsMessage.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          recipientPhone: input.recipientPhone,
          encryptedMessage: input.encryptedMessage,
          metadata: input.metadata,
          status: 'QUEUED',
          deliveryAttempts: 0,
          retryRounds: 0,
          retentionExpiresAt: new Date(now.getTime() + retentionLifetimeMilliseconds),
        },
      });

      await transaction.outboxEvent.create({
        data: {
          aggregateType: 'SMS_MESSAGE',
          aggregateId: message.id,
          eventType: 'SMS_MESSAGE_QUEUED',
          payload: { messageId: message.id },
        },
      });

      await transaction.smsIdempotencyKey.create({
        data: {
          key: input.idempotencyKey,
          expiresAt: new Date(now.getTime() + idempotencyLifetimeMilliseconds),
          smsMessageId: message.id,
        },
      });

      return { created: true, message };
    });
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
