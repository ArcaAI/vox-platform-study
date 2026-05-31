import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { TenantStorageConfigService } from './tenant-storage-config.service';
import { ITenantStorageConfigService } from './ITenantStorageConfigService';

/**
 * Wires {@link TenantStorageConfigService}. The {@link BlobStorageProviderFactory}
 * it depends on is provided globally by `BlobStorageModule.forRoot()` (registered
 * at the app root), so only the tenant repositories ({@link CoreDatabaseModule})
 * need importing here.
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [
    {
      provide: ITenantStorageConfigService,
      useClass: TenantStorageConfigService,
    },
    TenantStorageConfigService,
  ],
  exports: [ITenantStorageConfigService, TenantStorageConfigService],
})
export class TenantStorageConfigServiceModule {}
