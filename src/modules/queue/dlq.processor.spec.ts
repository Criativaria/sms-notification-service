import { Job } from 'bullmq';

import { SmsDispatchJobData } from './queue.constants';
import { DlqProcessor } from './dlq.processor';

describe('DlqProcessor', () => {
  it('completes a dead-letter notification without using it as state', async () => {
    const processor = new DlqProcessor();
    const job = { data: { messageId: 'msg-1' } } as Job<SmsDispatchJobData>;

    await expect(processor.process(job)).resolves.toEqual({ status: 'notified' });
  });
});
