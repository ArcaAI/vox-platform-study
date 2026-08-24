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
import { UsageLedgerServiceModule } from '../../usageLedger';
import { NotificationServiceModule } from '../../notification';
import { GateEditMiningServiceModule } from '../../gate-edit-mining/gate-edit-mining.service.module';
import { AiProviderConnectionServiceModule } from '../../ai-provider-connection/ai-provider-connection.service.module';

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
    // Supplies the @Optional IUsageLedgerService the constructor injects but
    // NEVER calls (double-bill guard; see the
    // service's constructor doc comment).
    UsageLedgerServiceModule,
    // TASK-711 — supplies the @Optional INotificationService the TIMED_OUT
    // path uses for the clinician notification (best-effort).
    NotificationServiceModule,
    // TASK-795 W2 (finishing TASK-792's R7) — supplies `IGateEditExemplarRetriever` for the
    // `PromptAssemblyService` provided below; `@Optional()` there, so absent ⇒ this path
    // silently produced a zero-shot prompt.
    //
    // This is the one that mattered most. The admin console's ONLY "Generate" mutation is
    // `useGenerateSummaryAsync` -> `POST :id/summary/async`, and that route resolves the
    // note-generation seam to the HARNESS generator (`consultation.controller.ts` — the legacy
    // branch now throws 503), which comes back through `HarnessInternalService.assemble`. So the
    // product's primary generation path was one of the two that could not see an exemplar.
    GateEditMiningServiceModule,
    // TASK-799 lane B — supplies `IProviderConnectionService` for
    // `resolveProviderCredential`, the harness worker's ONLY route to a BYO
    // credential. `@Optional()` in the service, so an unwired plane degrades to
    // the fail-closed `unavailable` outcome rather than a DI error; wiring it
    // here is what makes the tenant → SYSTEM cascade actually reachable from a
    // Temporal activity.
    AiProviderConnectionServiceModule,
  ],
  providers: [HarnessInternalService, PromptAssemblyService],
  exports: [HarnessInternalService],
})
export class HarnessInternalServiceModule {}
