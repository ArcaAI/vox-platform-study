import { Module } from '@nestjs/common';
import { WorkflowExposureServiceModule } from '@arcaai/applications';
import { WorkflowsController } from './workflows.controller';
import { WorkflowStreamService } from './workflow-stream.service';

/**
 * `WorkflowsModule` — mounts the exposure plane at `/workflows/*` (global
 * prefix -> `/api/v1/workflows/*`), TASK-722.
 */
@Module({
  imports: [WorkflowExposureServiceModule],
  controllers: [WorkflowsController],
  providers: [WorkflowStreamService],
})
export class WorkflowsModule {}
