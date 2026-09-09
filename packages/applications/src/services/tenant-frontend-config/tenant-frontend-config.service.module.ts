import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { TenantFrontendConfigService } from './tenant-frontend-config.service';
import { ITenantFrontendConfigService } from './ITenantFrontendConfigService';

/**
 * Wires {@link TenantFrontendConfigService}: the core repositories
 * ({@link CoreDatabaseModule}) plus the settings cascade
 * ({@link EffectiveSettingsModule}).
 */
@Module({
  // TASK-932 S2-4 — `EffectiveSettingsModule` supplies `TenantSettingsService`,
  // which resolves the `enable-local-raw-capture` platform capability. It was
  // read straight off the `@Global()` `IAppSettingsService` before, so this
  // import is what makes the registry cascade reachable here.
  imports: [CoreDatabaseModule, EffectiveSettingsModule],
  providers: [
    TenantFrontendConfigService,
    {
      provide: ITenantFrontendConfigService,
      // useExisting, not useClass — useClass would construct a second
      // TenantFrontendConfigService instance instead of aliasing the one
      // above. No cache/listener/timer state here, so the duplicate was
      // harmless, but aliasing is free.
      useExisting: TenantFrontendConfigService,
    },
  ],
  exports: [ITenantFrontendConfigService, TenantFrontendConfigService],
})
export class TenantFrontendConfigServiceModule {}
