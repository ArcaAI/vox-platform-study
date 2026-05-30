import { DynamicModule, Module } from '@nestjs/common';

import { AppSettingsModule } from '../_meta/appSettings';
import { BlobStorageService } from './blob-storage.service';
import { IBlobStorageService } from './IBlobStorageService';
import { BlobStorageProviderFactory } from './providers/blob-storage.provider.factory';

/**
 * BlobStorageModule — registers the provider-agnostic blob-storage stack
 * (TASK-318 / W1):
 *
 * - {@link BlobStorageProviderFactory} — selects S3/MinIO or Azure per the
 *   `STORAGE_PROVIDER` config value and caches the instantiated client.
 * - {@link IBlobStorageService} (→ {@link BlobStorageService}) — the single
 *   entry point consumers will depend on.
 *
 * Depends on AppSettingsModule for non-secret config; Azure/S3 credentials are
 * resolved at runtime via the (optional, globally provided) SecretsService.
 *
 * Additive in W1 — this module is not imported anywhere yet. A later wave wires
 * it into the app and migrates consumers off the legacy S3Service.
 *
 * Usage:
 * - `BlobStorageModule.forRoot()` — self-contained (imports AppSettingsModule).
 * - `BlobStorageModule.forFeature()` — when AppSettingsModule is already global.
 */
@Module({
  providers: [
    BlobStorageProviderFactory,
    {
      provide: IBlobStorageService,
      useClass: BlobStorageService,
    },
  ],
  exports: [IBlobStorageService, BlobStorageProviderFactory],
})
export class BlobStorageModule {
  /** Import with the AppSettingsModule dependency included (recommended). */
  static forRoot(): DynamicModule {
    return {
      module: BlobStorageModule,
      imports: [AppSettingsModule.forRoot()],
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

  /** Import assuming AppSettingsModule.forRoot() is already globally available. */
  static forFeature(): DynamicModule {
    return {
      module: BlobStorageModule,
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
