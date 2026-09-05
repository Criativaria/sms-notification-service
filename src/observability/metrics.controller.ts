import { Controller, Get, UseGuards } from '@nestjs/common';

import { PrivateNetworkGuard } from '../modules/sms/guards/private-network.guard';
import { MetricsService, MetricsSnapshot } from './metrics.service';

@Controller('internal/metrics')
@UseGuards(PrivateNetworkGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  getMetrics(): Promise<MetricsSnapshot> {
    return this.metrics.snapshot();
  }
}
