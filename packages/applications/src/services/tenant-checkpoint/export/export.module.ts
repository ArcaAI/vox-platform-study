import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';

import { CommonServiceModule } from '../../baseServices';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { ICheckpointExportRunner, ICheckpointSealing, ICheckpointStore, ICheckpointVerifyRunner } from '../contracts';
import { CheckpointSealing } from '../sealing/checkpoint-sealing';
import { CheckpointStore } from '../store/checkpoint-store';
import { CHECKPOINT_DB_CONNECTOR, PgCheckpointDbConnector } from './db-connector';
import { CheckpointExportProcessor } from './export.processor';
import { CheckpointExportRunner } from './export-runner';
import { CheckpointSweeper } from './sweeper';
import { CheckpointVerifyRunner } from './verify-runner';

/**
 * The checkpoint worker's export side: runners, the queue processor and the sweepers.
 *
 * Relies on the worker app's globals: `ScheduleModule.forRoot()` (the sweeper's `@Cron`s),
 * `EventEmitterModule.forRoot()`, `BlobStorageModule.forRoot()` (BlobStorageProviderFactory),
 * the BullMQ root connection, and — optional — the @Global `RedisCacheModule` (retention lock).
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EffectiveSettingsModule, BullModule.registerQueue({ name: JobQueue.TenantCheckpointExport })],
  providers: [
    { provide: ICheckpointSealing, useClass: CheckpointSealing },
    { provide: ICheckpointStore, useClass: CheckpointStore },
    { provide: CHECKPOINT_DB_CONNECTOR, useFactory: () => new PgCheckpointDbConnector() },
    { provide: ICheckpointExportRunner, useClass: CheckpointExportRunner },
    { provide: ICheckpointVerifyRunner, useClass: CheckpointVerifyRunner },
    CheckpointExportProcessor,
    CheckpointSweeper,
  ],
  exports: [ICheckpointExportRunner, ICheckpointVerifyRunner],
})
export class CheckpointExportModule {}
