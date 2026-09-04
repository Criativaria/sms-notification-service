import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { DeliveryTerminalStatus } from '../../database/sms-lifecycle.repository';
import { SmsLifecycleRepository } from '../../database/sms-lifecycle.repository';

export type WebhookProvider = 'twilio' | 'bird';

/** 200-level acknowledgement returned to the provider. */
export type WebhookAck = { status: 'ok' } | { status: 'ignored' };

export interface RecordDeliveryReportInput {
  provider: WebhookProvider;
  providerMessageId: string;
  /** Mapped terminal status, or null when the provider status is non-terminal (ignored). */
  terminalStatus: DeliveryTerminalStatus | null;
  providerEventId?: string;
}

/**
 * Maps Twilio `MessageStatus` values to the canonical terminal status. Non-terminal
 * statuses (`queued`, `sending`, `sent`, `accepted`, ...) and unknown values return null
 * so the caller acknowledges without a state change.
 */
const TWILIO_STATUS_MAP: Readonly<Record<string, DeliveryTerminalStatus>> = {
  delivered: 'DELIVERED',
  undelivered: 'UNDELIVERED',
  failed: 'REJECTED',
};

/**
 * Maps Bird delivery statuses to the canonical terminal status. Bird's exact vocabulary is
 * not documented in a form we can validate here, so we cover the common spellings for its
 * delivered / failed / rejected equivalents. Non-terminal / unknown values return null.
 */
const BIRD_STATUS_MAP: Readonly<Record<string, DeliveryTerminalStatus>> = {
  delivered: 'DELIVERED',
  delivery_failed: 'UNDELIVERED',
  failed: 'UNDELIVERED',
  undelivered: 'UNDELIVERED',
  rejected: 'REJECTED',
};

/**
 * Provider-agnostic delivery-report handler. Maps provider DLR statuses to the canonical
 * terminal status, delegates the guarded state transition to {@link SmsLifecycleRepository},
 * and translates the repository outcome into an HTTP-shaped result. Never logs PII.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private readonly lifecycle: SmsLifecycleRepository) {}

  mapTwilioStatus(rawStatus: string): DeliveryTerminalStatus | null {
    return TWILIO_STATUS_MAP[rawStatus?.toLowerCase()] ?? null;
  }

  mapBirdStatus(rawStatus: string): DeliveryTerminalStatus | null {
    return BIRD_STATUS_MAP[rawStatus?.toLowerCase()] ?? null;
  }

  async recordDeliveryReport(input: RecordDeliveryReportInput): Promise<WebhookAck> {
    if (input.terminalStatus === null) {
      this.logger.log({
        event: 'WEBHOOK_RECEIVED',
        provider: input.provider,
        providerMessageId: input.providerMessageId,
        mappedStatus: 'ignored',
      });
      return { status: 'ignored' };
    }

    const result = await this.lifecycle.applyDeliveryReport({
      providerMessageId: input.providerMessageId,
      terminalStatus: input.terminalStatus,
      providerEventId: input.providerEventId,
    });

    this.logger.log({
      event: 'WEBHOOK_RECEIVED',
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      mappedStatus: input.terminalStatus,
      outcome: result.outcome,
    });

    switch (result.outcome) {
      case 'applied':
      case 'duplicate':
        return { status: 'ok' };
      case 'not_found':
        throw new NotFoundException('Unknown provider message id');
      case 'invalid_transition':
        throw new ConflictException('Delivery report conflicts with current message status');
    }
  }
}
