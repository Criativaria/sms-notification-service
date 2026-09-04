import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { verifyBirdSignature } from './signature/bird-signature.verifier';
import { WebhooksService, type WebhookAck } from './webhooks.service';

/**
 * Bird delivery-report payload shape.
 *
 * ASSUMPTION: real Bird DLR docs/credentials are unavailable. We accept the correlation id
 * from `id` (fallback `messageId` / `message.id`) and the status from `status`
 * (fallback `message.status`). The correlation id is the value persisted as
 * `providerMessageId` when the message was sent.
 */
interface BirdWebhookPayload {
  id?: string;
  messageId?: string;
  status?: string;
  eventId?: string;
  message?: { id?: string; status?: string };
}

/**
 * Receives Bird delivery status callbacks at `POST /webhooks/bird`.
 *
 * Authenticated by HMAC-SHA256 over the RAW request body using `BIRD_WEBHOOK_SIGNING_KEY`,
 * constant-time compared to the `X-Bird-Signature` header. Requires `req.rawBody`
 * (NestFactory must be created with `{ rawBody: true }`); an absent raw body is
 * unverifiable and rejected with 400.
 */
@Controller('webhooks')
export class BirdWebhookController {
  private readonly signingKey: string;

  constructor(
    configService: ConfigService,
    private readonly webhooksService: WebhooksService,
  ) {
    this.signingKey = configService.getOrThrow<string>('BIRD_WEBHOOK_SIGNING_KEY');
  }

  @Post('bird')
  @HttpCode(200)
  async handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-bird-signature') signature: string | undefined,
  ): Promise<WebhookAck> {
    const rawBody = request.rawBody;
    if (!rawBody) {
      throw new BadRequestException('Missing raw request body');
    }

    if (!verifyBirdSignature(this.signingKey, rawBody, signature)) {
      throw new ForbiddenException('Invalid Bird signature');
    }

    const payload = this.parsePayload(rawBody);
    const providerMessageId = payload.id ?? payload.messageId ?? payload.message?.id;
    if (!providerMessageId) {
      throw new BadRequestException('Missing message correlation id');
    }

    const rawStatus = payload.status ?? payload.message?.status ?? '';
    const terminalStatus = this.webhooksService.mapBirdStatus(rawStatus);

    return this.webhooksService.recordDeliveryReport({
      provider: 'bird',
      providerMessageId,
      terminalStatus,
      providerEventId: payload.eventId,
    });
  }

  private parsePayload(rawBody: Buffer): BirdWebhookPayload {
    try {
      return JSON.parse(rawBody.toString('utf-8')) as BirdWebhookPayload;
    } catch {
      throw new BadRequestException('Invalid JSON body');
    }
  }
}
