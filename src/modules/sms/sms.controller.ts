import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';

import { SendSmsDto } from './dto/send-sms.dto';
import { PrivateNetworkGuard } from './guards/private-network.guard';
import { AcceptedSmsResult, SmsService } from './sms.service';

interface SendSmsResponse {
  status: 'success';
  data: AcceptedSmsResult;
}

@Controller('api/v1/sms')
@UseGuards(PrivateNetworkGuard)
export class SmsController {
  constructor(private readonly smsService: SmsService) {}

  @Post('send')
  @HttpCode(202)
  async send(
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    @Body() body: SendSmsDto,
  ): Promise<SendSmsResponse> {
    const data = await this.smsService.acceptMessage(idempotencyKey, body);

    return { status: 'success', data };
  }
}
