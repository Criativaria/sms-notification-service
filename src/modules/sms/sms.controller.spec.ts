import { AcceptedSmsResult, SmsService } from './sms.service';
import { SmsController } from './sms.controller';
import { SendSmsDto } from './dto/send-sms.dto';

describe('SmsController', () => {
  const accepted: AcceptedSmsResult = {
    messageId: '77b9aa41-4ba3-4785-b593-7d0265416cde',
    status: 'QUEUED',
    createdAt: '2026-09-04T12:00:00.000Z',
  };

  function createController() {
    const acceptMessage = jest.fn(() => Promise.resolve(accepted));
    const smsService = { acceptMessage } as unknown as SmsService;

    return { controller: new SmsController(smsService), acceptMessage };
  }

  it('returns the success envelope with the accepted data', async () => {
    const { controller, acceptMessage } = createController();
    const body: SendSmsDto = { to: '+14155552671', message: 'hello' };

    const response = await controller.send('request-123', body);

    expect(acceptMessage).toHaveBeenCalledWith('request-123', body);
    expect(response).toEqual({ status: 'success', data: accepted });
  });
});
