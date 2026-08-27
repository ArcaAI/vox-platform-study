import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ConsultationContextSchemaServiceModule } from '../consultation-context-schema/consultation-context-schema.service.module';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { PipelineServiceModule } from '../stt/pipeline/pipeline.service.module';
import { WorkflowValidatorServiceModule } from '../workflow-validator/workflow-validator.service.module';
import { SttPipelineCompilerService } from './compilers/stt-pipeline.compiler';
import { IWorkflowDefinitionService } from './IWorkflowDefinitionService';
import { SttPipelineResolverService } from './resolvers/stt-pipeline-resolver.service';
import { WorkflowDefinitionService } from './workflow-definition.service';

/**
 * WorkflowDefinitionService DI module (TASK-734).
 *
 * - CommonServiceModule       -> config + globals + `CORE_DATABASE_SERVICE` (the version-mint
 *   transaction in `create()` needs `databaseService.baseClient.$transaction`).
 * - CoreDatabaseModule        -> `WorkflowDefinitionRepository`.
 * - EntitlementsServiceModule -> `IEntitlementsService`, the `maxWorkflowDefinitions` quota
 *   precheck on `create()`.
 * - PipelineServiceModule     -> `PipelineService`, TASK-724 Task 4's `SttPipelineCompilerService`
 *   writes an `stt`-palette publish's compiled graph through it (never a raw repository call);
 *   Task 6's `SttPipelineResolverService` reads it back the same way.
 *
 * - WorkflowValidatorServiceModule -> `WorkflowValidatorService` (TASK-790 W3a). Resolves the
 *   SYSTEM ∪ tenant `WorkflowInvariantRule` rows and applies the one-way-strictness merge, so
 *   `validateGraph()` evaluates the rule set that actually applies to the tenant rather than only
 *   the bundled code catalogue. Before this import the service was constructed nowhere outside
 *   its own module (TASK-789 H-1).
 *
 * - ConsultationContextSchemaServiceModule -> `IConsultationContextSchemaService` (TASK-810 D-7).
 *   `publish()` resolves the tenant's SERVABLE context-schema version through it and pins that id
 *   into `compiledConfig.policyBindings`, replacing the hardcoded `contextSchemaVersionId: null`
 *   every compile used to carry. That module imports only `CommonServiceModule` +
 *   `CoreDatabaseModule`, so this import closes no cycle.
 *
 * `SttPipelineResolverService` is exported (not just provided) because its consumer — the
 * session/consultation-open call site that resolves `pipelineId` — is a FUTURE, separate wiring
 * pass (README §4 Task 6; deliberately not this ticket's diff, proved by
 * `task-724-stt-realtime-untouched.grep-gate.test.ts`), likely from a module outside this one.
 */
@Module({
  imports: [
    CommonServiceModule,
    ConsultationContextSchemaServiceModule,
    CoreDatabaseModule,
    EntitlementsServiceModule,
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
