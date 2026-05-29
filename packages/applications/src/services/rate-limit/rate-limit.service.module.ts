import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices';
import { GlobalSettingServiceModule } from '../globalSetting/globalSetting.service.module';
import { IRateLimitSettingsService } from './IRateLimitSettingsService';
import { IRateLimitAdminService } from './IRateLimitAdminService';
import { RateLimitSettingsService } from './rate-limit-settings.service';
import { RateLimitAdminService } from './rate-limit-admin.service';

/**
 * TASK-316 — provides the DB-backed rate-limit read accessor and admin write
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
