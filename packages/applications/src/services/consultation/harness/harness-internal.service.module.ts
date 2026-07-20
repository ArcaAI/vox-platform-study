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
import { RedisCacheModule } from '../../baseServices/redis';
import { HarnessPolicyServiceModule } from '../../harness-policy/harness-policy.service.module';

/**
 * HarnessInternalService DI module (TASK-330 Phase 1 — Lane G). Wires the
 * inbound gate-adapter service to the existing prompt-assembly chain, WORM audit
 * trail, and the consultation job service (for SSE draft progress).
 */
@Module({
  imports: [
    CoreDatabaseModule,
    // TASK-355 Phase C (R-6) / TASK-533 D-23 — supplies ConfigService for the
    // warm-start env FALLBACK (HARNESS_WARM_START_ENABLED). The authority is now
    // HarnessPolicy.warmStartEnabled via HarnessPolicyServiceModule below; both
    // HarnessInternalService and the PromptAssemblyService provided here resolve it.
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
    // TASK-466 (C1-03) — supplies IRedisCacheService so the WORM/draft callbacks
    // dedup on the harness Idempotency-Key (best-effort; @Optional in the service).
    RedisCacheModule.register(),
    // TASK-533 D-23 — supplies HarnessPolicyService so the effective
    // `warmStartEnabled` (not the process-wide env var) governs prior-draft
    // injection, per tenant and without a redeploy.
    HarnessPolicyServiceModule,
  ],
  providers: [HarnessInternalService, PromptAssemblyService],
  exports: [HarnessInternalService],
})
export class HarnessInternalServiceModule {}
