import { Module } from '@nestjs/common';
import { WorkflowSandboxRunServiceModule } from '@arcaai/applications';
import { WorkflowSandboxRunController } from './workflow-sandbox-run.controller';
import { WorkflowSandboxStreamService } from './workflow-sandbox-stream.service';

/**
 * `WorkflowSandboxRunModule` — mounts the Workbench's run surface at
 * `admin/workflow-definitions/:definitionId/sandbox-runs/*`.
 */
@Module({
  imports: [WorkflowSandboxRunServiceModule],
  controllers: [WorkflowSandboxRunController],
  providers: [WorkflowSandboxStreamService],
})
export class WorkflowSandboxRunModule {}
