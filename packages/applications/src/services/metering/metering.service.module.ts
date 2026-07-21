import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IMeteringService } from './IMeteringService';
import { MeteringService } from './metering.service';

/**
 * Registers the self-scheduling {@link MeteringService}.
 *
 * Relies on the app-level globals `ScheduleModule.forRoot()` (SchedulerRegistry)
 * and `EventEmitterModule.forRoot()` (@OnEvent). `CommonServiceModule` provides
 * the cached `IAppSettingsService`; `CoreDatabaseModule` the `CORE_DATABASE_SERVICE`
 * token used for the unscoped cross-tenant aggregate + meter upsert. Exports the
 * `IMeteringService` token so the entitlements capability snapshot (and the
 * Phase-3 meter prechecks) can inject live usage.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IMeteringService,
      useClass: MeteringService,
    },
  ],
  exports: [IMeteringService],
})
export class MeteringServiceModule {}
