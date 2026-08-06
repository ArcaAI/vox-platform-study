import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { IShadowMeteringService } from './IShadowMeteringService';
import { ShadowMeteringService } from './shadow-metering.service';

/**
 * Registers the self-scheduling {@link ShadowMeteringService}.
 *
 * Same wiring as `MeteringServiceModule`: relies on the app-level globals
 * `ScheduleModule.forRoot()` and `EventEmitterModule.forRoot()`;
 * `CommonServiceModule` supplies the cached `IAppSettingsService`;
 * `CoreDatabaseModule` supplies `CORE_DATABASE_SERVICE` for the unscoped
 * cross-tenant reads this report needs.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IShadowMeteringService,
      useClass: ShadowMeteringService,
    },
  ],
  exports: [IShadowMeteringService],
})
export class ShadowMeteringServiceModule {}
