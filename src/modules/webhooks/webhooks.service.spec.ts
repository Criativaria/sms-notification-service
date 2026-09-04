import { ConflictException, NotFoundException } from '@nestjs/common';

import type {
  ApplyDeliveryReportResult,
  LifecycleSmsMessage,
  SmsLifecycleRepository,
} from '../../database/sms-lifecycle.repository';
import { WebhooksService } from './webhooks.service';

describe('WebhooksService', () => {
  const message = { id: 'msg-1', status: 'DELIVERED' } as unknown as LifecycleSmsMessage;

  function createService(result?: ApplyDeliveryReportResult) {
    const applyDeliveryReport = jest.fn(() => Promise.resolve(result));
    const lifecycle = { applyDeliveryReport } as unknown as SmsLifecycleRepository;
    return { service: new WebhooksService(lifecycle), applyDeliveryReport };
  }

  describe('mapTwilioStatus', () => {
    it('maps terminal statuses', () => {
      const { service } = createService();
      expect(service.mapTwilioStatus('delivered')).toBe('DELIVERED');
      expect(service.mapTwilioStatus('undelivered')).toBe('UNDELIVERED');
      expect(service.mapTwilioStatus('failed')).toBe('REJECTED');
    });

    it('returns null for non-terminal or unknown statuses', () => {
      const { service } = createService();
      expect(service.mapTwilioStatus('queued')).toBeNull();
      expect(service.mapTwilioStatus('sending')).toBeNull();
      expect(service.mapTwilioStatus('sent')).toBeNull();
      expect(service.mapTwilioStatus('accepted')).toBeNull();
      expect(service.mapTwilioStatus('bogus')).toBeNull();
    });
  });

  describe('mapBirdStatus', () => {
    it('maps terminal statuses', () => {
      const { service } = createService();
      expect(service.mapBirdStatus('delivered')).toBe('DELIVERED');
      expect(service.mapBirdStatus('delivery_failed')).toBe('UNDELIVERED');
      expect(service.mapBirdStatus('failed')).toBe('UNDELIVERED');
      expect(service.mapBirdStatus('rejected')).toBe('REJECTED');
    });

    it('returns null for non-terminal or unknown statuses', () => {
      const { service } = createService();
      expect(service.mapBirdStatus('accepted')).toBeNull();
      expect(service.mapBirdStatus('sending')).toBeNull();
      expect(service.mapBirdStatus('bogus')).toBeNull();
    });
  });

  describe('recordDeliveryReport', () => {
    it('returns ignored and makes no repo call for a non-terminal status', async () => {
      const { service, applyDeliveryReport } = createService();

      const ack = await service.recordDeliveryReport({
        provider: 'twilio',
        providerMessageId: 'msg-1',
        terminalStatus: null,
      });

      expect(ack).toEqual({ status: 'ignored' });
      expect(applyDeliveryReport).not.toHaveBeenCalled();
    });

    it('returns ok on applied and forwards the mapped status', async () => {
      const { service, applyDeliveryReport } = createService({ outcome: 'applied', message });

      const ack = await service.recordDeliveryReport({
        provider: 'twilio',
        providerMessageId: 'msg-1',
        terminalStatus: 'DELIVERED',
        providerEventId: 'evt-1',
      });

      expect(ack).toEqual({ status: 'ok' });
      expect(applyDeliveryReport).toHaveBeenCalledWith({
        providerMessageId: 'msg-1',
        terminalStatus: 'DELIVERED',
        providerEventId: 'evt-1',
      });
    });

    it('returns ok on duplicate', async () => {
      const { service } = createService({ outcome: 'duplicate', message });

      await expect(
        service.recordDeliveryReport({
          provider: 'bird',
          providerMessageId: 'msg-1',
          terminalStatus: 'DELIVERED',
        }),
      ).resolves.toEqual({ status: 'ok' });
    });

    it('throws NotFoundException on not_found', async () => {
      const { service } = createService({ outcome: 'not_found' });

      await expect(
        service.recordDeliveryReport({
          provider: 'twilio',
          providerMessageId: 'unknown',
          terminalStatus: 'DELIVERED',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ConflictException on invalid_transition', async () => {
      const { service } = createService({
        outcome: 'invalid_transition',
        currentStatus: 'DELIVERED',
      });

      await expect(
        service.recordDeliveryReport({
          provider: 'twilio',
          providerMessageId: 'msg-1',
          terminalStatus: 'REJECTED',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
