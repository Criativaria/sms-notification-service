import {
  ConflictException,
  Controller,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SmsLifecycleRepository } from '../../database/sms-lifecycle.repository';
import { PrivateNetworkGuard } from '../sms/guards/private-network.guard';

interface RequeueResponse {
  messageId: string;
  status: 'requeued';
}

/**
 * Private-network-only operational endpoint to replay a dead-lettered message back onto
 * the dispatch queue. Restricted to callers inside `PRIVATE_NETWORK_CIDRS` by the reused
 * {@link PrivateNetworkGuard}.
 *
 * `FATAL_FAILURE` is terminal in the normal state machine, so the requeue path uses the
 * administrative {@link SmsLifecycleRepository.resetForRequeue} override to move the message
 * back to `RETRY_SCHEDULED` (restoring a full retry budget) and atomically records a requeue
 * outbox intent. The relay publishes that intent after the database transaction commits.
 */
@Controller('internal/dlq')
@UseGuards(PrivateNetworkGuard)
export class DlqController {
  private readonly logger = new Logger(DlqController.name);

  constructor(private readonly lifecycle: SmsLifecycleRepository) {}

  @Post(':messageId/requeue')
  @HttpCode(202)
  async requeue(@Param('messageId') messageId: string): Promise<RequeueResponse> {
    const result = await this.lifecycle.resetForRequeue(messageId);

    if (result.outcome === 'not_found') {
      throw new NotFoundException(`SMS message ${messageId} not found`);
    }

    if (result.outcome === 'not_fatal') {
      throw new ConflictException(
        `Only FATAL_FAILURE messages can be requeued; ${messageId} is ${result.currentStatus}`,
      );
    }

    this.logger.log(`DLQ_REQUEUE messageId=${messageId}`);

    return { messageId, status: 'requeued' };
  }
}
