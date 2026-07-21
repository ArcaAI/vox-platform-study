import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { IPlatformMetricsService } from './IPlatformMetricsService';
import { PlatformMetricsService } from './platform-metrics.service';
import { IPrometheusQueryService, PrometheusQueryService } from './prometheus-query.service';
import { ISocketRegistryService, SocketRegistryService } from './socket-registry.service';

/**
 * Platform runtime metrics module, plus the socket registry.
 *
 * `IRedisCacheService` is provided globally by `RedisCacheModule` (@Global), so
 * it is injected without a local import. `CoreDatabaseModule` supplies
 * `CORE_DATABASE_SERVICE` for the Postgres consumption aggregates.
 *
 * `ISocketRegistryService` is exported so the API gateway's `SttWsGateway` can
 * publish its per-instance live-socket count (#5 multi-instance aggregation).
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [
    { provide: IPlatformMetricsService, useClass: PlatformMetricsService },
    { provide: IPrometheusQueryService, useClass: PrometheusQueryService },
    { provide: ISocketRegistryService, useClass: SocketRegistryService },
  ],
  exports: [IPlatformMetricsService, IPrometheusQueryService, ISocketRegistryService],
})
export class PlatformMetricsServiceModule {}
