import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { CryptoServiceModule } from '../crypto/crypto.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { ICheckpointSealing, ICheckpointStore } from './contracts';
import { CheckpointSealing } from './sealing/checkpoint-sealing';
import { CheckpointStore } from './store/checkpoint-store';
import { ITenantCheckpointService } from './ITenantCheckpointService';
import { TenantCheckpointService } from './tenant-checkpoint.service';

/**
 * The checkpoint API's service. It PRODUCES export and restore jobs; the checkpoint worker consumes
 * them. Sealing (Vault Transit) and the store (platform bucket) are provided here because the gateway
 * wraps the archive key and signs download URLs itself.
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    CryptoServiceModule,
    EffectiveSettingsModule,
    BullModule.registerQueue({ name: JobQueue.TenantCheckpointExport }, { name: JobQueue.TenantCheckpointRestore }),
  ],
  providers: [
    CheckpointSealing,
    CheckpointStore,
    { provide: ICheckpointSealing, useExisting: CheckpointSealing },
    { provide: ICheckpointStore, useExisting: CheckpointStore },
    TenantCheckpointService,
    { provide: ITenantCheckpointService, useExisting: TenantCheckpointService },
  ],
  exports: [ITenantCheckpointService, TenantCheckpointService, ICheckpointSealing, ICheckpointStore],
})
export class TenantCheckpointServiceModule {}
