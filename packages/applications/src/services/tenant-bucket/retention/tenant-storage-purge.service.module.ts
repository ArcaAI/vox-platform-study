import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { TenantStoragePurgeService } from './tenant-storage-purge.service';

/**
 * TASK-1025 G2 — registers the self-scheduling {@link TenantStoragePurgeService}.
 *
 * Relies on the app-level globals `ScheduleModule.forRoot()` (SchedulerRegistry),
 * `EventEmitterModule.forRoot()` (@OnEvent), `BlobStorageModule.forRoot()`
 * (BlobStorageProviderFactory) and, when registered, the @Global
 * `RedisCacheModule` (the cross-replica run lock — optional).
 * `CommonServiceModule` provides `IAppSettingsService`; `CoreDatabaseModule`
 * the tenant and tenant-bucket repositories.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [TenantStoragePurgeService],
  exports: [TenantStoragePurgeService],
})
export class TenantStoragePurgeServiceModule {}
