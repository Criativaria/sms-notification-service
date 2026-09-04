import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';
import { SmsLifecycleRepository } from './sms-lifecycle.repository';
import { SMS_PERSISTENCE_CLIENT, SmsPersistenceRepository } from './sms-persistence.repository';

@Global()
@Module({
  providers: [
    PrismaService,
    { provide: SMS_PERSISTENCE_CLIENT, useExisting: PrismaService },
    SmsPersistenceRepository,
    SmsLifecycleRepository,
  ],
  exports: [PrismaService, SmsPersistenceRepository, SmsLifecycleRepository],
})
export class DatabaseModule {}
