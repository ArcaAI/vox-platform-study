import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices';
import { GlobalSettingServiceModule } from '../globalSetting/globalSetting.service.module';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { IRateLimitSettingsService } from './IRateLimitSettingsService';
import { IRateLimitAdminService } from './IRateLimitAdminService';
import { RateLimitSettingsService } from './rate-limit-settings.service';
import { RateLimitAdminService } from './rate-limit-admin.service';

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
  imports: [CommonServiceModule, GlobalSettingServiceModule],
  providers: [
    // The `global-kv` cascade backing the per-tenant lane (TASK-558 lane I).
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
  ],
  exports: [IRateLimitSettingsService, IRateLimitAdminService],
})
export class RateLimitServiceModule {}
