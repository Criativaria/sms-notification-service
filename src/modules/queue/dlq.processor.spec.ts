import { Job } from 'bullmq';

import { MetricsService } from '../../observability/metrics.service';
import { SmsDispatchJobData } from './queue.constants';
import { DlqProcessor } from './dlq.processor';

describe('DlqProcessor', () => {
  it('records and completes a dead-letter notification without using it as state', async () => {
    const metrics = { recordDeadLetterNotification: jest.fn() };
    const processor = new DlqProcessor(metrics as unknown as MetricsService);
    const job = { data: { messageId: 'msg-1' } } as Job<SmsDispatchJobData>;

    await expect(processor.process(job)).resolves.toEqual({ status: 'notified' });

    expect(metrics.recordDeadLetterNotification).toHaveBeenCalledTimes(1);
  });
});
