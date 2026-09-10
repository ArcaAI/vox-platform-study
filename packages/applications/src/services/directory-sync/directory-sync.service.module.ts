import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { FederatedAuthServiceModule } from '../federated-auth/federated-auth.service.module';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { DirectorySyncService } from './directory-sync.service';
import { DirectorySyncProcessor } from './directory-sync.processor';
import { MsGraphDirectoryProvider } from './ms-graph-directory.provider';
import { GoogleDirectoryProvider } from './google-directory.provider';

/**
 * DirectorySyncServiceModule — admin-triggered directory
 * pre-provisioning. Wires the `SyncTenantDirectoryUsers` BullMQ queue, the
 * enqueue-side service, the paged-pull worker, and the two directory
 * providers (each individually gated, PER TENANT, by
 * `tenantIdp.msGraph.enabled` / `tenantIdp.googleDirectory.enabled` — platform-admin
 * written, default OFF; TASK-870 item 12 replaced the platform-wide env switches
 * those providers used to freeze in their constructors).
 */
@Module({
  imports: [
    ConfigModule,
    HttpModule,
    CommonServiceModule,
    CoreDatabaseModule,
    FederatedAuthServiceModule,
    EntitlementsServiceModule,
    // Resolves the @Optional EffectiveSettingsService both the enqueue path and the
    // worker use for the per-tenant availability gate. Without this import the
    // @Optional injection is undefined and every sync DENIES — fail-closed, but
    // silently, so the import is load-bearing rather than decorative.
    EffectiveSettingsModule,
    BullModule.registerQueue({ name: JobQueue.SyncTenantDirectoryUsers }),
  ],
  providers: [DirectorySyncService, DirectorySyncProcessor, MsGraphDirectoryProvider, GoogleDirectoryProvider],
  exports: [DirectorySyncService],
})
export class DirectorySyncServiceModule {}
