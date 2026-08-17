import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { PipelineServiceModule } from '../stt/pipeline/pipeline.service.module';
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
 * `SttPipelineResolverService` is exported (not just provided) because its consumer — the
 * session/consultation-open call site that resolves `pipelineId` — is a FUTURE, separate wiring
 * pass (README §4 Task 6; deliberately not this ticket's diff, proved by
 * `task-724-stt-realtime-untouched.grep-gate.test.ts`), likely from a module outside this one.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EntitlementsServiceModule, PipelineServiceModule],
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
