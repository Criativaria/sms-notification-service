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

import { verifyTwilioSignature } from './signature/twilio-signature.verifier';
import { WebhooksService, type WebhookAck } from './webhooks.service';

/**
 * Receives Twilio delivery status callbacks at `POST /webhooks/twilio`.
 *
 * The request is authenticated by recomputing Twilio's HMAC-SHA1 signature over the full
 * callback URL plus the sorted form parameters and constant-time comparing it to the
 * `X-Twilio-Signature` header. Requires `req.rawBody` (NestFactory must be created with
 * `{ rawBody: true }`); an absent raw body is unverifiable and rejected with 400.
 */
@Controller('webhooks')
export class TwilioWebhookController {
  private readonly authToken: string;
  private readonly callbackUrl: string;

  constructor(
    configService: ConfigService,
    private readonly webhooksService: WebhooksService,
  ) {
    this.authToken = configService.getOrThrow<string>('TWILIO_AUTH_TOKEN');
    const serviceUrl = configService.getOrThrow<string>('SERVICE_URL').replace(/\/+$/, '');
    this.callbackUrl = `${serviceUrl}/webhooks/twilio`;
  }

  @Post('twilio')
  @HttpCode(200)
  async handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-twilio-signature') signature: string | undefined,
  ): Promise<WebhookAck> {
    const rawBody = request.rawBody;
    if (!rawBody) {
      throw new BadRequestException('Missing raw request body');
    }

    const params = this.parseFormParams(rawBody);

    if (!verifyTwilioSignature(this.authToken, this.callbackUrl, params, signature)) {
      throw new ForbiddenException('Invalid Twilio signature');
    }

    const providerMessageId = params.MessageSid;
    if (!providerMessageId) {
      throw new BadRequestException('Missing MessageSid');
    }

    const terminalStatus = this.webhooksService.mapTwilioStatus(params.MessageStatus ?? '');

    return this.webhooksService.recordDeliveryReport({
      provider: 'twilio',
      providerMessageId,
      terminalStatus,
      providerEventId: params.SmsSid,
    });
  }

  private parseFormParams(rawBody: Buffer): Record<string, string> {
    const parsed = new URLSearchParams(rawBody.toString('utf-8'));
    const params: Record<string, string> = {};
    for (const [key, value] of parsed.entries()) {
      params[key] = value;
    }
    return params;
  }
}
