import { Module } from '@nestjs/common';
import { CommonServiceModule, WorkflowExposureServiceModule, WorkflowRunServiceModule } from '@arcaai/applications';
import { ConsultationWorkflowRunsController } from './consultation-workflow-runs.controller';
import { WorkflowHooksController } from './workflow-hooks.controller';
import { WorkflowRunCompletionModule } from './workflow-run-completion.module';
import { WorkflowsController } from './workflows.controller';
import { WorkflowStreamService } from './workflow-stream.service';

/**
 * `WorkflowsModule` — mounts the exposure plane at `/workflows/*` (global
 * prefix -> `/api/v1/workflows/*`),.
 *
 * `CommonServiceModule` supplies `IConfigService`, which `WorkflowStreamService` needs for the
 * Redis connection details of the run event stream it consumes (lane A — the read that
 * replaced the poll). It is injected `@Optional()` there, so a Nest context built without this
 * import degrades to snapshot-only rather than failing to construct.
 */
@Module({
  imports: [CommonServiceModule, WorkflowExposureServiceModule, WorkflowRunServiceModule, WorkflowRunCompletionModule],
  // lane A mounts a SECOND controller here rather than in the consultation module: both
  // planes are the same handler with the same service, and the whole safety argument is that the
  // difference between them is one path parameter. Splitting them across modules would put that
  // difference two files apart from the code that depends on it.
  // TASK-864: `WorkflowHooksController` is the inbound webhook trigger (a `@Public()` route
  // authenticated by HMAC); `WorkflowRunCompletionService` is the background consumer that
  // records a run's terminal status without a reader (G9). TASK-946 D3 moved that service into
  // its own `@Global()` module so `ConsultationWorkflowDispatchService` — a provider in
  // `@arcaai/applications`, which cannot import this app — can attach a watcher through the
  // `IWorkflowRunCompletionPort` token. Re-exported here so this module's existing consumers
  // keep resolving it exactly as before.
  controllers: [WorkflowsController, ConsultationWorkflowRunsController, WorkflowHooksController],
  providers: [WorkflowStreamService],
  exports: [WorkflowStreamService, WorkflowRunCompletionModule],
})
export class WorkflowsModule {}
