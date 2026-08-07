import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { TenantFrontendConfigService } from './tenant-frontend-config.service';
import { ITenantFrontendConfigService } from './ITenantFrontendConfigService';

/**
 * Wires {@link TenantFrontendConfigService}. Only the core
 * repositories ({@link CoreDatabaseModule}) are needed.
 */
@Module({
  imports: [CoreDatabaseModule],
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
