import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { DynamicModule, Module, type ModuleMetadata } from '@nestjs/common';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';

import { JwtRevocationModule } from '../../auth/jwt-revocation.module';
import { CommonServiceModule } from '../../baseServices';
import { KnowledgeVectorCleanupClient } from '../../knowledge/knowledge-vector-cleanup.client';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { ICheckpointSealing, ICheckpointStore } from '../contracts';
import { TenantLockModule } from '../lock/tenant-lock.module';
import { CheckpointSealing } from '../sealing/checkpoint-sealing';
import { CheckpointStore } from '../store/checkpoint-store';
import { CheckpointMediaRestorer } from './media-restorer';
import { CheckpointRestorePostCommit } from './post-commit';
import { CheckpointReconciler } from './reconciler';
import { CHECKPOINT_RESTORE_DB, PgRestoreDb } from './restore-row';
import { CheckpointRestoreProcessor } from './restore.processor';
import { CheckpointRestoreRunner } from './restore.runner';
import { CheckpointRestoreSweeper } from './restore-sweeper';

/**
 * The checkpoint worker's restore side: runner, queue processor and stale-restore sweeper.
 *
 * The SAFETY checkpoint runs through `ICheckpointExportRunner`, which this module does not
 * provide: register it with the module that does —
 * `CheckpointRestoreModule.withExport(CheckpointExportModule)`.
 *
 * Relies on the worker app's globals: `ScheduleModule.forRoot()` (the sweeper's `@Cron`),
 * `EventEmitterModule.forRoot()`, `BlobStorageModule.forRoot()` (BlobStorageProviderFactory),
 * the BullMQ root connection, and — optional — `AuthorizationModule` (PolicyEngine, so the Redis
 * ability cache is dropped post-commit).
 */
const metadata: ModuleMetadata = {
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    EffectiveSettingsModule,
    TenantLockModule,
    JwtRevocationModule,
    HttpModule,
    BullModule.registerQueue({ name: JobQueue.TenantCheckpointRestore }, { name: JobQueue.IngestKnowledgeDocument }),
  ],
  providers: [
    { provide: ICheckpointSealing, useClass: CheckpointSealing },
    { provide: ICheckpointStore, useClass: CheckpointStore },
    { provide: CHECKPOINT_RESTORE_DB, useFactory: () => new PgRestoreDb() },
    KnowledgeVectorCleanupClient,
    CheckpointReconciler,
    CheckpointMediaRestorer,
    CheckpointRestorePostCommit,
    CheckpointRestoreRunner,
    CheckpointRestoreProcessor,
    CheckpointRestoreSweeper,
  ],
  exports: [CheckpointRestoreRunner],
};

@Module(metadata)
export class CheckpointRestoreModule {
  /** `exportModule` must export `ICheckpointExportRunner` (the export side's module). */
  static withExport(exportModule: NonNullable<ModuleMetadata['imports']>[number]): DynamicModule {
    return { module: CheckpointRestoreModule, imports: [exportModule] };
  }
}
