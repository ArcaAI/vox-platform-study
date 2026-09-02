import { Module } from '@nestjs/common';
import { CommonServiceModule, WorkflowExposureServiceModule } from '@arcaai/applications';
import { ConsultationWorkflowRunsController } from './consultation-workflow-runs.controller';
import { WorkflowsController } from './workflows.controller';
import { WorkflowStreamService } from './workflow-stream.service';

/**
 * `WorkflowsModule` — mounts the exposure plane at `/workflows/*` (global
 * prefix -> `/api/v1/workflows/*`), TASK-722.
 *
 * `CommonServiceModule` supplies `IConfigService`, which `WorkflowStreamService` needs for the
 * Redis connection details of the run event stream it consumes (TASK-849 lane A — the read that
 * replaced the poll). It is injected `@Optional()` there, so a Nest context built without this
 * import degrades to snapshot-only rather than failing to construct.
 */
@Module({
  imports: [CommonServiceModule, WorkflowExposureServiceModule],
  // TASK-850 lane A mounts a SECOND controller here rather than in the consultation module: both
  // planes are the same handler with the same service, and the whole safety argument is that the
  // difference between them is one path parameter. Splitting them across modules would put that
  // difference two files apart from the code that depends on it.
  controllers: [WorkflowsController, ConsultationWorkflowRunsController],
  providers: [WorkflowStreamService],
})
export class WorkflowsModule {}
