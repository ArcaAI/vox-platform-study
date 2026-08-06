import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { UsageLedgerServiceModule } from '../usageLedger';
import { AgentTrajectoryService } from './agent-trajectory.service';
import { IAgentTrajectoryService } from './IAgentTrajectoryService';

/**
 * AgentTrajectoryService DI module.
 *
 * - CommonServiceModule → config + globals (the @Global RedisCacheModule supplies
 *   `IRedisCacheService` for the live-view republish; injected @Optional).
 * - CoreDatabaseModule  → `AgentTrajectoryStepRepository` AND the DOMAINS
 *   `CoreUnitOfWorkService` (TASK-615 WS-D2) that folds `createMany` + the
 *   usage-ledger emission into one transaction in `recordSteps`.
 * - UsageLedgerServiceModule → `IUsageLedgerService` for the TASK-615 WS-F
 *   usage-ledger emission hook in `recordSteps` (injected @Optional so unit
 *   fixtures can still construct the service without it).
 *
 * Exports both the symbol token (for `@Inject(IAgentTrajectoryService)`) and the
 * concrete class so emitter modules (live-doc, summary) can wire it directly.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, UsageLedgerServiceModule],
  providers: [AgentTrajectoryService, { provide: IAgentTrajectoryService, useClass: AgentTrajectoryService }],
  exports: [IAgentTrajectoryService, AgentTrajectoryService],
})
export class AgentTrajectoryServiceModule {}
