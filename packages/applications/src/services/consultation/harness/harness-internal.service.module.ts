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
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';

/**
 * HarnessInternalService DI module. Wires the
 * inbound gate-adapter service to the existing prompt-assembly chain, WORM audit
 * trail, and the consultation job service (for SSE draft progress).
 */
@Module({
  imports: [
    CoreDatabaseModule,
    // Supplies ConfigService for the
    // warm-start env FALLBACK (HARNESS_WARM_START_ENABLED). The authority is now
    // HarnessPolicy.warmStartEnabled via HarnessPolicyServiceModule below; both
    // HarnessInternalService and the PromptAssemblyService provided here resolve it.
    ConfigModule,
    PromptResolutionServiceModule,
    HarnessAuditServiceModule,
    ConsultationJobServiceModule,
    // Supplies HarnessAssuranceService so
    // finalizeAssurance can publish the terminal `assurance_complete` SSE event.
    HarnessAssuranceServiceModule,
    // Supplies ConfigResolver so assemble can thread the
    // doctor's preferred prompt id (Tier-0) through the async/harness path.
    ConfigResolverModule,
    // Supplies IRedisCacheService so the WORM/draft callbacks
    // dedup on the harness Idempotency-Key (best-effort; @Optional in the service).
    RedisCacheModule.register(),
    // Supplies HarnessPolicyService so the effective
    // `warmStartEnabled` (not the process-wide env var) governs prior-draft
    // injection, per tenant and without a redeploy.
    HarnessPolicyServiceModule,
    // Resolves the @Optional EffectiveSettingsService so
    // `agentic.revisit.carryForwardEnabled` (F-18) is governed by the control
    // plane rather than a redeploy. Unwired ⇒ carry-forward stays OFF.
    EffectiveSettingsModule,
  ],
  providers: [HarnessInternalService, PromptAssemblyService],
  exports: [HarnessInternalService],
})
export class HarnessInternalServiceModule {}
