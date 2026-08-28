import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { WorkflowAssignmentServiceModule } from '../../workflow-assignment/workflow-assignment.service.module';
import { PromptResolutionService } from './prompt-resolution.service';

/**
 * `WorkflowAssignmentServiceModule` resolves the `@Optional()`
 * `IWorkflowAssignmentService` that TASK-815 made the source of tier-1a: the
 * governing workflow definition, walked `department -> tenant -> platform
 * default`. `WorkflowDefinitionRepository` comes from `CoreDatabaseModule`,
 * already imported here.
 *
 * Both injections are `@Optional()` on the service so a background job
 * processor or a unit test can construct it positionally; wiring them HERE is
 * what makes tier-1a actually resolve in the running gateway, and
 * `prompt-resolution.di-wiring.task815.test.ts` is the guard that this import
 * is not dropped.
 */
@Module({
  imports: [CoreDatabaseModule, WorkflowAssignmentServiceModule],
  providers: [PromptResolutionService],
  exports: [PromptResolutionService],
})
export class PromptResolutionServiceModule {}
