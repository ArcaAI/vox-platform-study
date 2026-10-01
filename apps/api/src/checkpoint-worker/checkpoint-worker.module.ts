import {
  BlobStorageModule,
  CheckpointExportModule,
  CommonServiceModule,
  ConfigModule,
  LoggingServiceModule,
  SysEventServiceModule,
  TenantLockModule,
} from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsModule } from 'nestjs-cls';
import { TenantContextProviderModule } from '../database/tenant-context.provider';
import { VaultPrismaFactoryModule } from '../vault-prisma.module';

/**
 * CheckpointWorkerModule — the ROOT module of the tenant-checkpoint worker,
 * booted by `checkpoint-worker.main.ts` as an application CONTEXT: no HTTP
 * server, no controllers, no guards. It is the ONLY consumer of the
 * `TenantCheckpointExport` and `TenantCheckpointRestore` queues; the gateway
 * only enqueues.
 *
 * Same globals as the model-publisher worker (configuration, secrets,
 * Redis/BullMQ, storage, the Vault-backed database, CLS, the event bus whose
 * sys-events `SysEventServiceModule` turns into audit jobs), plus a scheduler
 * for the stale-job and retention sweepers.
 */
@Module({
  imports: [
    LoggingServiceModule,
    ConfigModule.forRoot(),
    ClsModule.forRoot({ global: true }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    VaultPrismaFactoryModule,
    BlobStorageModule.forRoot(),
    TenantContextProviderModule,
    CoreDatabaseModule,
    CommonServiceModule,
    SysEventServiceModule,
    TenantLockModule,
    CheckpointExportModule,
  ],
})
export class CheckpointWorkerModule {}
