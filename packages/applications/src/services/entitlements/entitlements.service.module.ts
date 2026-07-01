import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { GlobalSettingServiceModule } from '../globalSetting/globalSetting.service.module';
import { TenantServiceModule } from '../tenant/tenant.service.module';
import { MeteringServiceModule } from '../metering/metering.service.module';
import { PlatformMetricsServiceModule } from '../platform-metrics/platform-metrics.service.module';
import { IEntitlementsService } from './IEntitlementsService';
import { EntitlementsService } from './entitlements.service';
import { IEntitlementsLifecycleService } from './IEntitlementsLifecycleService';
import { EntitlementsLifecycleService } from './entitlements-lifecycle.service';

/**
 * TASK-392 — provides the DB-backed plan-entitlements service.
 *
 * `CoreDatabaseModule` exposes the tenant/plan/override/api-key repositories;
 * `CommonServiceModule` the cached `IAppSettingsService` (kill-switch read);
 * `GlobalSettingServiceModule` the `IGlobalSettingService` write path;
 * `TenantServiceModule` the `ITenantService` used to compose usage stats; and
 * `MeteringServiceModule` the `IMeteringService` for live rolling-monthly meter
 * usage (Q5); and `PlatformMetricsServiceModule` the `ISocketRegistryService`
 * that supplies the live per-tenant open-socket count for the concurrency gate
 * (TASK-392). Importing this module lets the API gateway inject
 * `IEntitlementsService` into the NEW entitlements controller (Phase 4) and the
 * per-service quota checks (Phase 3).
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    GlobalSettingServiceModule,
    TenantServiceModule,
    MeteringServiceModule,
    PlatformMetricsServiceModule,
  ],
  providers: [
    {
      provide: IEntitlementsService,
      useClass: EntitlementsService,
    },
    {
      // TASK-392 (Q4/Q10) — trial-expiry sweep + explicit downgrade soft-disable.
      provide: IEntitlementsLifecycleService,
      useClass: EntitlementsLifecycleService,
    },
  ],
  exports: [IEntitlementsService, IEntitlementsLifecycleService],
})
export class EntitlementsServiceModule {}
