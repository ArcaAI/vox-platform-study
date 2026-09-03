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
import { PromptManagementServiceModule } from '../prompt-management/prompt-management.service.module';
import { ConsultationJobServiceModule } from '../consultation/jobs/consultation-job.service.module';
import { HarnessPolicyServiceModule } from '../harness-policy/harness-policy.service.module';
import { PipelinePolicyServiceModule } from '../pipeline-policy';
import { ConfigResolverModule } from '../config-resolver';
import { PhiRedactionServiceModule } from '../phi-redaction/phi-redaction.service.module';
import { TextRequestServiceModule } from '../text-request/text-request.service.module';

@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    HttpModule,
    ConfigModule,
    PromptManagementServiceModule,
    ConsultationJobServiceModule,
    HarnessPolicyServiceModule, // TEXT-selection resolver for DnaWritingStyleProcessor
    // the shared TEXT credential/profile enrichment. TEXT holds no
    // endpoint or credential of its own; without a `provider_overrides` entry it
    // fails closed with 503 PROVIDER_CREDENTIALS_MISSING.
    TextRequestServiceModule,
    // PipelinePolicyService backs the per-doctor DNA
    // toggle (service); ConfigResolver gates the processor's learning corpus.
    PipelinePolicyServiceModule,
    ConfigResolverModule,
    PhiRedactionServiceModule, // hop 2 — IPhiRedactor for DnaWritingStyleProcessor's full-redact-before-TEXT call
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
