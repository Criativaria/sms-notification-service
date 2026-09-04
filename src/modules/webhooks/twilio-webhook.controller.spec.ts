import {
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import type {
  ApplyDeliveryReportResult,
  LifecycleSmsMessage,
  SmsLifecycleRepository,
} from '../../database/sms-lifecycle.repository';
import { TwilioWebhookController } from './twilio-webhook.controller';
import { WebhooksService } from './webhooks.service';
import { computeTwilioSignature } from './signature/twilio-signature.verifier';

const AUTH_TOKEN = 'test-auth-token';
const SERVICE_URL = 'http://localhost:3000';
const CALLBACK_URL = `${SERVICE_URL}/webhooks/twilio`;
const message = { id: 'msg-1', status: 'DELIVERED' } as unknown as LifecycleSmsMessage;

function buildRequest(params: Record<string, string>): RawBodyRequest<Request> {
  const rawBody = Buffer.from(new URLSearchParams(params).toString(), 'utf-8');
  return { rawBody } as RawBodyRequest<Request>;
}

function createController(result?: ApplyDeliveryReportResult) {
  const applyDeliveryReport = jest.fn(() => Promise.resolve(result));
  const lifecycle = { applyDeliveryReport } as unknown as SmsLifecycleRepository;
  const configService = {
    getOrThrow: (key: string) => (key === 'TWILIO_AUTH_TOKEN' ? AUTH_TOKEN : SERVICE_URL),
  } as unknown as ConfigService;

  const controller = new TwilioWebhookController(configService, new WebhooksService(lifecycle));
  return { controller, applyDeliveryReport };
}

describe('TwilioWebhookController', () => {
  it('applies a delivered report with a valid signature and returns ok', async () => {
    const { controller, applyDeliveryReport } = createController({ outcome: 'applied', message });
    const params = { MessageSid: 'SM1', MessageStatus: 'delivered', SmsSid: 'SM1' };
    const signature = computeTwilioSignature(AUTH_TOKEN, CALLBACK_URL, params);

    const response = await controller.handle(buildRequest(params), signature);

    expect(response).toEqual({ status: 'ok' });
    expect(applyDeliveryReport).toHaveBeenCalledWith({
      providerMessageId: 'SM1',
      terminalStatus: 'DELIVERED',
      providerEventId: 'SM1',
    });
  });

  it('rejects a tampered signature with 403 and makes no repo call', async () => {
    const { controller, applyDeliveryReport } = createController();
    const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
    const signature = computeTwilioSignature(AUTH_TOKEN, CALLBACK_URL, params);

    await expect(controller.handle(buildRequest(params), `${signature}x`)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(applyDeliveryReport).not.toHaveBeenCalled();
  });

  it('rejects a missing raw body with 400', async () => {
    const { controller } = createController();

    await expect(controller.handle({} as RawBodyRequest<Request>, 'sig')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns 404 for an unknown provider message id', async () => {
    const { controller } = createController({ outcome: 'not_found' });
    const params = { MessageSid: 'SMx', MessageStatus: 'delivered' };
    const signature = computeTwilioSignature(AUTH_TOKEN, CALLBACK_URL, params);

    await expect(controller.handle(buildRequest(params), signature)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns ok for a duplicate callback', async () => {
    const { controller } = createController({ outcome: 'duplicate', message });
    const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
    const signature = computeTwilioSignature(AUTH_TOKEN, CALLBACK_URL, params);

    await expect(controller.handle(buildRequest(params), signature)).resolves.toEqual({
      status: 'ok',
    });
  });

  it('returns 409 for an invalid transition', async () => {
    const { controller } = createController({
      outcome: 'invalid_transition',
      currentStatus: 'DELIVERED',
    });
    const params = { MessageSid: 'SM1', MessageStatus: 'failed' };
    const signature = computeTwilioSignature(AUTH_TOKEN, CALLBACK_URL, params);

    await expect(controller.handle(buildRequest(params), signature)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('ignores a non-terminal status with no repo call', async () => {
    const { controller, applyDeliveryReport } = createController();
    const params = { MessageSid: 'SM1', MessageStatus: 'sent' };
    const signature = computeTwilioSignature(AUTH_TOKEN, CALLBACK_URL, params);

    const response = await controller.handle(buildRequest(params), signature);

    expect(response).toEqual({ status: 'ignored' });
    expect(applyDeliveryReport).not.toHaveBeenCalled();
  });
});
