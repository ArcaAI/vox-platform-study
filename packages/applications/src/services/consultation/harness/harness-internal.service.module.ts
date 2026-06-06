import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { HarnessInternalService } from './harness-internal.service';
import { HarnessAuditServiceModule } from '../../harness-audit';
import { PromptResolutionServiceModule } from '../prompt/prompt-resolution.service.module';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { ConsultationJobServiceModule } from '../jobs/consultation-job.service.module';

/**
 * HarnessInternalService DI module (TASK-330 Phase 1 — Lane G). Wires the
 * inbound gate-adapter service to the existing prompt-assembly chain, WORM audit
 * trail, and the consultation job service (for SSE draft progress).
 */
@Module({
  imports: [
    CoreDatabaseModule,
    PromptResolutionServiceModule,
    HarnessAuditServiceModule,
    ConsultationJobServiceModule,
  ],
  providers: [HarnessInternalService, PromptAssemblyService],
  exports: [HarnessInternalService],
})
export class HarnessInternalServiceModule {}
