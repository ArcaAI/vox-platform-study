import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { FederatedAuthServiceModule } from '../federated-auth/federated-auth.service.module';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { DirectorySyncService } from './directory-sync.service';
import { DirectorySyncProcessor } from './directory-sync.processor';
import { MsGraphDirectoryProvider } from './ms-graph-directory.provider';
import { GoogleDirectoryProvider } from './google-directory.provider';

/**
 * DirectorySyncServiceModule — admin-triggered directory
 * pre-provisioning. Wires the `SyncTenantDirectoryUsers` BullMQ queue, the
 * enqueue-side service, the paged-pull worker, and the two directory
 * providers (each individually kill-switched — `TENANT_IDP_MS_GRAPH_ENABLED`
 * / `TENANT_IDP_GOOGLE_DIRECTORY_ENABLED`, default OFF).
 */
@Module({
  imports: [
    ConfigModule,
    HttpModule,
    CommonServiceModule,
    CoreDatabaseModule,
    FederatedAuthServiceModule,
    EntitlementsServiceModule,
    BullModule.registerQueue({ name: JobQueue.SyncTenantDirectoryUsers }),
  ],
  providers: [DirectorySyncService, DirectorySyncProcessor, MsGraphDirectoryProvider, GoogleDirectoryProvider],
  exports: [DirectorySyncService],
})
export class DirectorySyncServiceModule {}
