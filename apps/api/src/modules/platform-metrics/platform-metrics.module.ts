import { Module } from '@nestjs/common';
import { PlatformMetricsServiceModule } from '@arcaai/applications';
import { PlatformMetricsController } from './platform-metrics.controller';

/**
 * Wires the platform runtime metrics controller to
 * the application `PlatformMetricsServiceModule` (which provides
 * `IPlatformMetricsService`, the Prometheus query client, and the Redis socket
 * registry). Registered in `app.module.ts` `featureModules`.
 */
@Module({
  imports: [PlatformMetricsServiceModule],
  controllers: [PlatformMetricsController],
})
export class PlatformMetricsModule {}
