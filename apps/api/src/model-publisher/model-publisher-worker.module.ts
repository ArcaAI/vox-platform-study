import { AiModelPublisherWorkerModule, CommonServiceModule, ConfigModule, LoggingServiceModule, SysEventServiceModule } from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsModule } from 'nestjs-cls';
import { TenantContextProviderModule } from '../database/tenant-context.provider';
import { VaultPrismaFactoryModule } from '../vault-prisma.module';

/**
 * ModelPublisherWorkerModule — the ROOT module of the model-publisher worker
 * (TASK-1019 OD-1), booted by `model-publisher.main.ts` as an application
 * CONTEXT: no HTTP server, no controllers, no guards.
 *
 * It carries exactly what `AiModelDownloadProcessor` needs and nothing of the
 * gateway: configuration + secrets + Redis/BullMQ + storage config
 * (`CommonServiceModule`), the database (`CoreDatabaseModule`, the Vault
 * dynamic-credential factory and the CLS → Prisma tenant-scope adapter, the
 * same three the gateway wires), logging, a global CLS (the processor binds
 * each job's tenant with `cls.run`) and an event bus whose sys-events
 * (`ResourceDeleted` on unregister) `SysEventServiceModule` turns into the
 * audit/webhook queue jobs `hope-api` consumes.
 *
 * `hope-api` imports only `AiModelDownloadProducerModule`; the processor is in
 * this graph alone (`__tests__/model-publisher-module-graph.test.ts`).
 */
@Module({
  imports: [
    LoggingServiceModule,
    ConfigModule.forRoot(),
    ClsModule.forRoot({ global: true }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    VaultPrismaFactoryModule,
    TenantContextProviderModule,
    CoreDatabaseModule,
    CommonServiceModule,
    SysEventServiceModule,
    AiModelPublisherWorkerModule,
  ],
})
export class ModelPublisherWorkerModule {}
