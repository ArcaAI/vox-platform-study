import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { DnaWritingStyleService } from './dna-writing-style.service';
import { IDnaWritingStyleService } from './IDnaWritingStyleService';
import { DnaWritingStyleProcessor } from './dna-writing-style.processor';
import { DnaRegenerationScheduler } from './dna-regeneration.scheduler';
import { CommonServiceModule } from '../baseServices';
import { AgentServiceModule } from '../agent/agent.service.module';
import { PromptManagementServiceModule } from '../prompt-management/prompt-management.service.module';
import { ConsultationJobServiceModule } from '../consultation/jobs/consultation-job.service.module';
import { HarnessPolicyServiceModule } from '../harness-policy/harness-policy.service.module';
import { ConfigResolverModule } from '../config-resolver';
import { PhiRedactionServiceModule } from '../phi-redaction/phi-redaction.service.module';
import { TextRequestServiceModule } from '../text-request/text-request.service.module';
import { UsageLedgerServiceModule } from '../usageLedger/usage-ledger.service.module';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { BillingServiceModule } from '../billing/billing.service.module';

@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    HttpModule,
    ConfigModule,
    PromptManagementServiceModule,
    ConsultationJobServiceModule,
    // TASK-974 D-1 — `AgentResolverService` + `TextAgentResolverService` for the PLATFORM DNA
    // analyst (`AgentRepository` and `CORE_DATABASE_SERVICE` come from `CoreDatabaseModule`
    // above). Named rather than left to an `@Optional()` absence: without it the processor falls
    // back to the pre-974 finalize-agent selection, which is the behaviour this ticket replaced.
    AgentServiceModule,
    HarnessPolicyServiceModule, // legacy TEXT-selection resolver; only the positional fixtures reach it now
    // the shared TEXT credential/profile enrichment. TEXT holds no
    // endpoint or credential of its own; without a `provider_overrides` entry it
    // fails closed with 503 PROVIDER_CREDENTIALS_MISSING.
    TextRequestServiceModule,
    // ConfigResolver reads the per-doctor DNA decision (the tenant's `agent.dna_style` node +
    // the doctor's `UserSettings` preference, TASK-882); CoreDatabaseModule above supplies the
    // `UserSettings` repository the self-service write goes through.
    ConfigResolverModule,
    PhiRedactionServiceModule, // hop 2 — IPhiRedactor for DnaWritingStyleProcessor's full-redact-before-TEXT call
    // TASK-974 §9.2 (D-5) — the billing plane.
    //
    // `UsageLedgerServiceModule` supplies `IUsageLedgerService` (the processor's `dna.analyze`
    // batch and the service's `dna.ingest` row) and `IComputeDeviceResolver` (which device a
    // self-hosted engine ran on, so the occupancy seconds are a GPU second rather than a CPU
    // one — they are priced an order of magnitude apart). `CoreUnitOfWorkService` comes from
    // `CoreDatabaseModule` above: it is what lets the outbox row commit WITH the report.
    UsageLedgerServiceModule,
    // The two PRE-checks, run before `dnaQueue.add` rather than after the model has already
    // spent: `assertMeterQuota(…, 'monthlyLlmTokens')` (429) and `assertSpendLimit` (402).
    EntitlementsServiceModule,
    BillingServiceModule,
    BullModule.registerQueue({ name: JobQueue.GenerateDnaReport }),
  ],
  providers: [
    DnaWritingStyleService,
    {
      provide: IDnaWritingStyleService,
      // useExisting, not useClass — useClass would construct a second
      // DnaWritingStyleService instance instead of aliasing the one above.
      // The self-scheduling piece here is DnaRegenerationScheduler, provided
      // once below (not duplicated); DnaWritingStyleService itself holds no
      // state, so this duplicate was harmless, but aliasing is free.
      useExisting: DnaWritingStyleService,
    },
    DnaWritingStyleProcessor,
    DnaRegenerationScheduler,
  ],
  exports: [IDnaWritingStyleService, DnaWritingStyleService, DnaRegenerationScheduler, BullModule],
})
export class DnaWritingStyleServiceModule {}
