import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { AgentAssignmentServiceModule } from '../../agent-assignment/agent-assignment.service.module';
import { WorkflowAssignmentServiceModule } from '../../workflow-assignment/workflow-assignment.service.module';
import { PromptResolutionService } from './prompt-resolution.service';
import { VisitTypeServiceModule } from '../visit-type/visit-type.service.module';

/**
 * `WorkflowAssignmentServiceModule` resolves the `@Optional()`
 * `IWorkflowAssignmentService` that made the source of tier-1a: the
 * governing workflow definition, walked `department -> tenant -> platform
 * default`. `WorkflowDefinitionRepository` comes from `CoreDatabaseModule`,
 * already imported here.
 *
 * Both injections are `@Optional()` on the service so a background job
 * processor or a unit test can construct it positionally; wiring them HERE is
 * what makes tier-1a actually resolve in the running gateway, and
 * `prompt-resolution.di-wiring.task815.test.ts` is the guard that this import
 * is not dropped.
 *
 * `AgentAssignmentServiceModule` does the same job for TASK-884's tag-selected agent tier:
 * unwired, a request carrying `agentSelectorTags` simply resolves the ordinary way, which is
 * indistinguishable from a request that carried none — so the wiring is what makes owner
 * decision #6 actually reachable, and its absence would be silent.
 */
@Module({
  imports: [VisitTypeServiceModule, CoreDatabaseModule, WorkflowAssignmentServiceModule, AgentAssignmentServiceModule],
  providers: [PromptResolutionService],
  exports: [PromptResolutionService],
})
export class PromptResolutionServiceModule {}
