import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { AgentServiceModule } from '../../agent/agent.service.module';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { TenantLockModule } from '../../tenant-checkpoint/lock/tenant-lock.module';
import { FactLedgerService } from './fact-ledger.service';
import { FactLedgerProcessor, FactLedgerQueue } from './fact-ledger.processor';
import { FactLedgerListener } from './fact-ledger.listener';

/**
 * The per-encounter fact ledger + encounter recap producer.
 *
 * `ITranscriptRecordServiceToken` (required) and `IAiActivityRunServiceToken` (optional) are
 * provided by the transcript-record and activity-run modules; the host composes them in.
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    // `AgentResolverService` + `AgentInvocationService`: the extractor is invoked by slug.
    AgentServiceModule,
    // The optional per-call chunk budget.
    EffectiveSettingsModule,
    TenantLockModule,
    BullModule.registerQueue({ name: JobQueue.ExtractFactLedger }),
  ],
  providers: [FactLedgerService, FactLedgerQueue, FactLedgerProcessor, FactLedgerListener],
  exports: [FactLedgerService, FactLedgerQueue],
})
export class FactLedgerServiceModule {}
