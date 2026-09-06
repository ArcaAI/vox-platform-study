import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { AgentServiceModule } from '../agent/agent.service.module';
import { AgentPromotionServiceModule } from '../agentPromotion/agentPromotion.service.module';
import { AuthorizationModule } from '../../authorization/authorization.module';
import { EvalServiceModule } from '../eval/eval.service.module';
import { AiRoutingPolicyServiceModule } from '../ai-routing-policy/ai-routing-policy.service.module';
import { ConsultationContextSchemaServiceModule } from '../consultation-context-schema/consultation-context-schema.service.module';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { PipelineServiceModule } from '../stt/pipeline/pipeline.service.module';
import { WorkflowValidatorServiceModule } from '../workflow-validator/workflow-validator.service.module';
import { SttPipelineCompilerService } from './compilers/stt-pipeline.compiler';
import { IWorkflowDefinitionService } from './IWorkflowDefinitionService';
import { SttPipelineResolverService } from './resolvers/stt-pipeline-resolver.service';
import { WorkflowDefinitionService } from './workflow-definition.service';

/**
 * WorkflowDefinitionService DI module.
 *
 * - CommonServiceModule -> config + globals + `CORE_DATABASE_SERVICE` (the version-mint
 *   transaction in `create()` needs `databaseService.baseClient.$transaction`).
 * - CoreDatabaseModule -> `WorkflowDefinitionRepository`.
 * - EntitlementsServiceModule -> `IEntitlementsService`, the `maxWorkflowDefinitions` quota
 *   precheck on `create()`.
 * PipelineServiceModule -> `PipelineService`, 's `SttPipelineCompilerService`
 *   writes an `stt`-palette publish's compiled graph through it (never a raw repository call);
 *   Task 6's `SttPipelineResolverService` reads it back the same way.
 *
 * WorkflowValidatorServiceModule -> `WorkflowValidatorService` (a). Resolves the
 *   SYSTEM ∪ tenant `WorkflowInvariantRule` rows and applies the one-way-strictness merge, so
 *   `validateGraph()` evaluates the rule set that actually applies to the tenant rather than only
 *   the bundled code catalogue. Before this import the service was constructed nowhere outside
 * its own module.
 *
 * ConsultationContextSchemaServiceModule -> `IConsultationContextSchemaService`.
 *   `publish()` resolves the tenant's SERVABLE context-schema version through it and pins that id
 *   into `compiledConfig.policyBindings`, replacing the hardcoded `contextSchemaVersionId: null`
 *   every compile used to carry. That module imports only `CommonServiceModule` +
 *   `CoreDatabaseModule`, so this import closes no cycle.
 *
 * AiRoutingPolicyServiceModule -> `IAiRoutingPolicyService`. `validateGraph()`
 *   asks it what generation hyper-parameters each agent node's bound provider configuration
 *   accepts, so a node tuning one the provider drops is refused at publish instead of being
 *   silently ignored at runtime. That module imports `CommonServiceModule` + `CoreDatabaseModule`
 *   + `AiProviderConnectionServiceModule`, none of which reach back here, so this closes no cycle.
 *
 * TASK-885 — the three cross-tenant dependencies:
 *
 * - AgentPromotionServiceModule -> `IAgentPromotionService`. The Global -> SYSTEM path IS that
 *   service's promotion plus a publish; this module CONSUMES it and never reimplements it.
 * - EvalServiceModule -> `EvalPromotionGateService`, which gates that path (owner #7).
 * - AuthorizationModule -> `PolicyEngine`, which is what makes "the actor holds manage rights in
 *   that OTHER tenant" answerable from a service. A decorator can express `action + subject`; it
 *   cannot express "…and also over there". Same precedent `AgentPromotionServiceModule` cites.
 *
 * None of the three reaches back here — `AgentPromotionServiceModule` imports
 * `CommonServiceModule` + `CoreDatabaseModule` + `EvalServiceModule` + `AuthorizationModule`,
 * `EvalServiceModule` imports `HarnessGatewayServiceModule` (`ConfigModule` + `HttpModule`) and
 * `AuthorizationModule` imports `ApiKeyServiceModule` — so these imports close no cycle.
 *
 * `SttPipelineResolverService` is exported (not just provided) because its consumer — the
 * session/consultation-open call site that resolves `pipelineId` — is a FUTURE, separate wiring
 * pass ( Task 6; deliberately not diff, proved by
 * `task-724-stt-realtime-untouched.grep-gate.test.ts`), likely from a module outside this one.
 */
@Module({
  imports: [
    // TASK-890 §3.5 — `IAgentService.publishAgentViews`, the per-agent facts the publish gate
    // checks a `core.agent` node's prompt references and generation overrides against. Named
    // rather than left to an @Optional() absence: without it the gate silently stops checking
    // them, which is not a state anyone would notice. `AgentServiceModule` does not import this
    // module (nor does anything it imports), so this closes no cycle.
    AgentServiceModule,
    AgentPromotionServiceModule,
    AiRoutingPolicyServiceModule,
    AuthorizationModule,
    CommonServiceModule,
    ConsultationContextSchemaServiceModule,
    CoreDatabaseModule,
    EntitlementsServiceModule,
    EvalServiceModule,
    PipelineServiceModule,
    WorkflowValidatorServiceModule,
  ],
  providers: [
    WorkflowDefinitionService,
    SttPipelineCompilerService,
    SttPipelineResolverService,
    {
      provide: IWorkflowDefinitionService,
      // useExisting, not useClass — useClass would construct a second
      // WorkflowDefinitionService instance instead of aliasing the one above.
      useExisting: WorkflowDefinitionService,
    },
  ],
  exports: [IWorkflowDefinitionService, WorkflowDefinitionService, SttPipelineResolverService],
})
export class WorkflowDefinitionServiceModule {}
