import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { AgentTrajectoryService } from './agent-trajectory.service';
import { IAgentTrajectoryService } from './IAgentTrajectoryService';

/**
 * AgentTrajectoryService DI module.
 *
 * - CommonServiceModule → config + globals (the @Global RedisCacheModule supplies
 *   `IRedisCacheService` for the live-view republish; injected @Optional).
 * - CoreDatabaseModule  → `AgentTrajectoryStepRepository`.
 *
 * Exports both the symbol token (for `@Inject(IAgentTrajectoryService)`) and the
 * concrete class so emitter modules (live-doc, summary) can wire it directly.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [AgentTrajectoryService, { provide: IAgentTrajectoryService, useClass: AgentTrajectoryService }],
  exports: [IAgentTrajectoryService, AgentTrajectoryService],
})
export class AgentTrajectoryServiceModule {}
