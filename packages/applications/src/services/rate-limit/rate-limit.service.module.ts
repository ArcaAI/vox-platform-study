import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { CommonServiceModule } from '../baseServices';
import { GlobalSettingServiceModule } from '../globalSetting/globalSetting.service.module';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { IRateLimitSettingsService } from './IRateLimitSettingsService';
import { IRateLimitAdminService } from './IRateLimitAdminService';
import { RateLimitSettingsService } from './rate-limit-settings.service';
import { RateLimitAdminService } from './rate-limit-admin.service';
import { IRateLimitRuleService } from './IRateLimitRuleService';
import { RateLimitRuleService } from './rate-limit-rule.service';
import { RateLimitRuleCache } from './rate-limit-rule.cache';

/**
 * Provides the DB-backed rate-limit read accessor and admin write
 * service.
 *
 * `CommonServiceModule` exposes `IAppSettingsService` (the cached read path);
 * `GlobalSettingServiceModule` exposes `IGlobalSettingService` (the write
 * path). Importing this module lets the API gateway inject
 * `IRateLimitSettingsService` into `TieredThrottlerGuard` and
 * `IRateLimitAdminService` into the admin controller.
 */
@Module({
  // `CoreDatabaseModule` supplies `RateLimitRuleRepository`; `EntitlementsServiceModule`
  // supplies rank 3 for `explain`.
  imports: [CommonServiceModule, GlobalSettingServiceModule, CoreDatabaseModule, EntitlementsServiceModule],
  providers: [
    // The `global-kv` cascade backing the per-tenant lane.
    // Provided LOCALLY rather than by importing `EffectiveSettingsModule`: that
    // module also pulls the pipeline resolver and the AI task-default service,
    // none of which the throttler needs, and this service's only dependency is
    // `IAppSettingsService` — already exported by `CommonServiceModule` above.
    TenantSettingsService,
    {
      provide: IRateLimitSettingsService,
      useClass: RateLimitSettingsService,
    },
    {
      provide: IRateLimitAdminService,
      useClass: RateLimitAdminService,
    },
    // The rule config plane (ranks 1, 2, 4). The cache is exported so the
    // gateway's throttler guard can read it without going through the service.
    RateLimitRuleCache,
    {
      provide: IRateLimitRuleService,
      useClass: RateLimitRuleService,
    },
  ],
  exports: [IRateLimitSettingsService, IRateLimitAdminService, IRateLimitRuleService, RateLimitRuleCache],
})
export class RateLimitServiceModule {}
