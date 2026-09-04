import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type {
  ApplyDeliveryReportResult,
  LifecycleSmsMessage,
  SmsLifecycleRepository,
} from '../../database/sms-lifecycle.repository';
import { BirdWebhookController } from './bird-webhook.controller';
import { WebhooksService } from './webhooks.service';
import { computeBirdSignature } from './signature/bird-signature.verifier';

const SIGNING_KEY = 'test-bird-webhook-key';
const message = { id: 'msg-1', status: 'DELIVERED' } as unknown as LifecycleSmsMessage;

function buildRequest(payload: unknown): { request: RawBodyRequest<Request>; signature: string } {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf-8');
  const signature = computeBirdSignature(SIGNING_KEY, rawBody);
  return { request: { rawBody } as RawBodyRequest<Request>, signature };
}

function createController(result?: ApplyDeliveryReportResult) {
  const applyDeliveryReport = jest.fn(() => Promise.resolve(result));
  const lifecycle = { applyDeliveryReport } as unknown as SmsLifecycleRepository;
  const configService = {
    getOrThrow: () => SIGNING_KEY,
  } as unknown as ConfigService;

  const controller = new BirdWebhookController(configService, new WebhooksService(lifecycle));
  return { controller, applyDeliveryReport };
}

describe('BirdWebhookController', () => {
  it('applies a delivered report with a valid signature and returns ok', async () => {
    const { controller, applyDeliveryReport } = createController({ outcome: 'applied', message });
    const { request, signature } = buildRequest({
      id: 'bird-1',
      status: 'delivered',
      eventId: 'evt-1',
    });

    const response = await controller.handle(request, signature);

    expect(response).toEqual({ status: 'ok' });
    expect(applyDeliveryReport).toHaveBeenCalledWith({
      providerMessageId: 'bird-1',
      terminalStatus: 'DELIVERED',
      providerEventId: 'evt-1',
    });
  });

  it('rejects a tampered signature with 403 and makes no repo call', async () => {
    const { controller, applyDeliveryReport } = createController();
    const { request, signature } = buildRequest({ id: 'bird-1', status: 'delivered' });

    await expect(controller.handle(request, `${signature.slice(0, -1)}0`)).rejects.toBeInstanceOf(
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
    const { request, signature } = buildRequest({ id: 'unknown', status: 'delivered' });

    await expect(controller.handle(request, signature)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns ok for a duplicate callback', async () => {
    const { controller } = createController({ outcome: 'duplicate', message });
    const { request, signature } = buildRequest({ id: 'bird-1', status: 'delivered' });

    await expect(controller.handle(request, signature)).resolves.toEqual({ status: 'ok' });
  });

  it('returns 409 for an invalid transition', async () => {
    const { controller } = createController({
      outcome: 'invalid_transition',
      currentStatus: 'DELIVERED',
    });
    const { request, signature } = buildRequest({ id: 'bird-1', status: 'rejected' });

    await expect(controller.handle(request, signature)).rejects.toBeInstanceOf(ConflictException);
  });

  it('ignores a non-terminal status with no repo call', async () => {
    const { controller, applyDeliveryReport } = createController();
    const { request, signature } = buildRequest({ id: 'bird-1', status: 'accepted' });

    const response = await controller.handle(request, signature);

    expect(response).toEqual({ status: 'ignored' });
    expect(applyDeliveryReport).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON after a valid signature with 400', async () => {
    const { controller } = createController();
    const rawBody = Buffer.from('{ not json', 'utf-8');
    const signature = computeBirdSignature(SIGNING_KEY, rawBody);

    await expect(
      controller.handle({ rawBody } as RawBodyRequest<Request>, signature),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
