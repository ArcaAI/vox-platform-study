import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { AgentTrajectoryServiceModule } from '../agent-trajectory';
import { WorkflowRunService } from './workflow-run.service';
import { IWorkflowRunService } from './IWorkflowRunService';

/**
 * WorkflowRunService DI module (TASK-723).
 *
 * - CommonServiceModule → config + globals.
 * - CoreDatabaseModule  → `WorkflowRunRepository`.
 * - AgentTrajectoryServiceModule → `IAgentTrajectoryService`, reused by
 *   `getRunTrace` for the single bounded step read (README Task 5 — PHI/
 *   `payloadRef` handling stays in one place).
 *
 * Exports both the symbol token (for `@Inject(IWorkflowRunService)`) and the
 * concrete class.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, AgentTrajectoryServiceModule],
  providers: [
    WorkflowRunService,
    {
      provide: IWorkflowRunService,
      // useExisting, not useClass — useClass would construct a second
      // WorkflowRunService instance instead of aliasing the one above.
      useExisting: WorkflowRunService,
    },
  ],
  exports: [IWorkflowRunService, WorkflowRunService],
})
export class WorkflowRunServiceModule {}
