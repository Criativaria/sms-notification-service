import { Job } from 'bullmq';

import { SmsLifecycleRepository } from '../../database/sms-lifecycle.repository';
import { AMBIGUOUS_OUTCOME_EXPIRY_JOB, SmsDispatchJobData } from '../queue/queue.constants';
import { AmbiguousOutcomeExpiryProcessor } from './ambiguous-outcome-expiry.processor';

describe('AmbiguousOutcomeExpiryProcessor', () => {
  it('marks only a still-awaiting message undelivered without invoking a provider or scheduling a retry', async () => {
    const lifecycle = {
      expireAmbiguousOutcome: jest.fn().mockResolvedValue({ outcome: 'expired' }),
    };
    const processor = new AmbiguousOutcomeExpiryProcessor(
      lifecycle as unknown as SmsLifecycleRepository,
    );

    await processor.process({
      name: AMBIGUOUS_OUTCOME_EXPIRY_JOB,
      data: { messageId: 'msg-1' },
    } as unknown as Job<SmsDispatchJobData>);

    expect(lifecycle.expireAmbiguousOutcome).toHaveBeenCalledWith('msg-1');
  });

  it('no-ops when a valid webhook already moved the message to a terminal status', async () => {
    const lifecycle = {
      expireAmbiguousOutcome: jest
        .fn()
        .mockResolvedValue({ outcome: 'not_awaiting_provider_result' }),
    };
    const processor = new AmbiguousOutcomeExpiryProcessor(
      lifecycle as unknown as SmsLifecycleRepository,
    );

    await processor.process({
      name: AMBIGUOUS_OUTCOME_EXPIRY_JOB,
      data: { messageId: 'msg-1' },
    } as unknown as Job<SmsDispatchJobData>);

    expect(lifecycle.expireAmbiguousOutcome).toHaveBeenCalledWith('msg-1');
  });
});
