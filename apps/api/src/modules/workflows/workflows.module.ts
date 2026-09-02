import { Module } from '@nestjs/common';
import { CommonServiceModule, WorkflowExposureServiceModule } from '@arcaai/applications';
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
  controllers: [WorkflowsController],
  providers: [WorkflowStreamService],
})
export class WorkflowsModule {}
