import { DynamicModule, Global, Module } from '@nestjs/common';

import { CoreDatabaseModule } from '@arcaai/domains';
import { BlobStorageService } from './blob-storage.service';
import { IBlobStorageService } from './IBlobStorageService';
import { BlobStorageProviderFactory } from './providers/blob-storage.provider.factory';

/**
 * BlobStorageModule — registers the provider-agnostic blob-storage stack
 * (TASK-318):
 *
 * - {@link BlobStorageProviderFactory} — selects S3/MinIO or Azure per the
 *   `STORAGE_PROVIDER` global config AND per-tenant/per-bucket
 *   {@link TenantStorageConfig} rows; caches resolved provider instances.
 * - {@link IBlobStorageService} (→ {@link BlobStorageService}) — the single,
 *   tenant-aware entry point consumers depend on.
 *
 * Registered as a {@link Global} module via {@link forRoot} so there is exactly
 * ONE factory instance app-wide. This is required for cache coherence: the
 * read path and `TenantStorageConfigService.invalidate()` must share the same
 * provider cache. Import `BlobStorageModule.forRoot()` once at the application
 * root (after `AppSettingsModule.forRoot()`); everywhere else, just inject
 * `IBlobStorageService` / `BlobStorageProviderFactory`.
 *
 * Depends on the globally-provided `IAppSettingsService` for non-secret config
 * and {@link CoreDatabaseModule} for the tenant repositories; Azure/S3
 * credentials are resolved at runtime via the (optional) SecretsService.
 */
@Global()
@Module({})
export class BlobStorageModule {
  static forRoot(): DynamicModule {
    return {
      module: BlobStorageModule,
      imports: [CoreDatabaseModule],
      providers: [
        BlobStorageProviderFactory,
        {
          provide: IBlobStorageService,
          useClass: BlobStorageService,
        },
      ],
      exports: [IBlobStorageService, BlobStorageProviderFactory],
    };
  }
}
