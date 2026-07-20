import { AgentTrajectoryServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AgentTrajectoryController } from './agent-trajectory.controller';

/**
 * AgentTrajectoryModule — the `/admin/agent-trajectory/*`
 * global-admin read plane over the ordered session trajectory.
 *
 * `AgentTrajectoryServiceModule` supplies `IAgentTrajectoryService` (ingest +
 * read + retention prune, built in Phase 2B). `ClsService` is global.
 */
@Module({
  imports: [AgentTrajectoryServiceModule],
  controllers: [AgentTrajectoryController],
})
export class AgentTrajectoryModule {}
