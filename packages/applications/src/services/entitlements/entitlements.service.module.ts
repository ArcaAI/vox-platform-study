import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { GlobalSettingServiceModule } from '../globalSetting/globalSetting.service.module';
import { TenantServiceModule } from '../tenant/tenant.service.module';
import { MeteringServiceModule } from '../metering/metering.service.module';
import { BillingServiceModule } from '../billing/billing.service.module';
import { TenantBucketServiceModule } from '../tenant-bucket/tenant-bucket.service.module';
import { PlatformMetricsServiceModule } from '../platform-metrics/platform-metrics.service.module';
import { IEntitlementsService } from './IEntitlementsService';
import { EntitlementsService } from './entitlements.service';
import { IEntitlementsLifecycleService } from './IEntitlementsLifecycleService';
import { EntitlementsLifecycleService } from './entitlements-lifecycle.service';

/**
 * Provides the DB-backed plan-entitlements service.
 *
 * `CoreDatabaseModule` exposes the tenant/plan/override/api-key repositories;
 * `CommonServiceModule` the cached `IAppSettingsService` (kill-switch read);
 * `GlobalSettingServiceModule` the `IGlobalSettingService` write path;
 * `TenantServiceModule` the `ITenantService` used to compose usage stats; and
 * `MeteringServiceModule` the `IMeteringService` for live rolling-monthly meter
 * usage (Q5); and `PlatformMetricsServiceModule` the `ISocketRegistryService`
 * that supplies the live per-tenant open-socket count for the concurrency gate
 * . Importing this module lets the API gateway inject
 * `IEntitlementsService` into the entitlements controller and the
 * per-service quota checks.
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    GlobalSettingServiceModule,
    TenantServiceModule,
    MeteringServiceModule,
    PlatformMetricsServiceModule,
    // TASK-986 (owner ruling D-7) — the plan-history writer and the
    // plan-derived bucket quota the trial-expiry sweep and the explicit
    // downgrade now maintain. Both are leaves relative to this module.
    BillingServiceModule,
    TenantBucketServiceModule,
  ],
  providers: [
    {
      provide: IEntitlementsService,
      useClass: EntitlementsService,
    },
    {
      // Trial-expiry sweep + explicit downgrade soft-disable.
      provide: IEntitlementsLifecycleService,
      useClass: EntitlementsLifecycleService,
    },
  ],
  exports: [IEntitlementsService, IEntitlementsLifecycleService],
})
export class EntitlementsServiceModule {}
