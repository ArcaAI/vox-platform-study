import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreDatabaseModule } from '@arcaai/domains';
import { HarnessInternalService } from './harness-internal.service';
import { HarnessAssuranceServiceModule } from './harness-assurance.service.module';
import { HarnessAuditServiceModule } from '../../harness-audit';
import { PromptResolutionServiceModule } from '../prompt/prompt-resolution.service.module';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { ConsultationJobServiceModule } from '../jobs/consultation-job.service.module';
import { ConfigResolverModule } from '../../config-resolver';

/**
 * HarnessInternalService DI module (TASK-330 Phase 1 — Lane G). Wires the
 * inbound gate-adapter service to the existing prompt-assembly chain, WORM audit
 * trail, and the consultation job service (for SSE draft progress).
 */
@Module({
  imports: [
    CoreDatabaseModule,
    // TASK-355 Phase C (R-6) — supplies ConfigService for the warm-start
    // kill-switch (HARNESS_WARM_START_ENABLED) read by both HarnessInternalService
    // and the PromptAssemblyService provided below.
    ConfigModule,
    PromptResolutionServiceModule,
    HarnessAuditServiceModule,
    ConsultationJobServiceModule,
    // TASK-355 Phase D Slice 5d — supplies HarnessAssuranceService so
    // finalizeAssurance can publish the terminal `assurance_complete` SSE event.
    HarnessAssuranceServiceModule,
    // TASK-356 Phase 5 — supplies ConfigResolver so assemble can thread the
    // doctor's preferred prompt id (Tier-0) through the async/harness path.
    ConfigResolverModule,
  ],
  providers: [HarnessInternalService, PromptAssemblyService],
  exports: [HarnessInternalService],
})
export class HarnessInternalServiceModule {}
