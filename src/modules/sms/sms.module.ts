import { Module } from '@nestjs/common';

import { CryptoModule } from '../../common/crypto/crypto.module';
import { SmsController } from './sms.controller';
import { SmsService } from './sms.service';

@Module({
  imports: [CryptoModule],
  controllers: [SmsController],
  providers: [SmsService],
})
export class SmsModule {}
