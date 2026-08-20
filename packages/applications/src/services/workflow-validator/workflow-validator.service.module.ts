import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { WorkflowValidatorService } from './workflow-validator.service';

/**
 * WorkflowValidatorService DI module (TASK-716 Task 8).
 *
 * - CoreDatabaseModule -> `WorkflowInvariantRuleRepository`, the rule rows.
 * - CommonServiceModule -> the house baseline every service module imports.
 *
 * NO symbol-token port. TASK-716's original Task 8 specified an
 * `IWorkflowValidatorService` token, but TASK-734 deliberately removed that port
 * when it wired the engine ("this service calls `@arcaai/workflow-contract`'s
 * validate/compile directly rather than through a speculative port nothing else
 * consumes" — `IWorkflowDefinitionService.ts`). Re-introducing the token for a
 * single in-process consumer would re-add exactly what that ticket removed, so
 * the concrete class is provided and exported instead — the same shape
 * `SttPipelineCompilerService` / `SttPipelineResolverService` already use in the
 * sibling `WorkflowDefinitionServiceModule`.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [WorkflowValidatorService],
  exports: [WorkflowValidatorService],
})
export class WorkflowValidatorServiceModule {}
