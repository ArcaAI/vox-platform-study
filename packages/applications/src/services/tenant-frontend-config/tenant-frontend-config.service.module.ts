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
    {
      provide: ITenantFrontendConfigService,
      useClass: TenantFrontendConfigService,
    },
    TenantFrontendConfigService,
  ],
  exports: [ITenantFrontendConfigService, TenantFrontendConfigService],
})
export class TenantFrontendConfigServiceModule {}
