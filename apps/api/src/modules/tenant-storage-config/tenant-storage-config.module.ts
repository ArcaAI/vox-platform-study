import { TenantStorageConfigServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { TenantStorageConfigAdminController } from './tenant-storage-config-admin.controller';

/**
 * Admin storage-configuration feature module (TASK-318 / R5). The
 * `BlobStorageProviderFactory` the service depends on is provided globally by
 * `BlobStorageModule.forRoot()` (registered in the app root), so only the
 * application service module is imported here.
 */
@Module({
  imports: [TenantStorageConfigServiceModule],
  controllers: [TenantStorageConfigAdminController],
})
export class TenantStorageConfigModule {}
