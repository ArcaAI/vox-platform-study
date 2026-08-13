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
 *   `CoreUnitOfWorkService` that folds `createMany` + the
 *   usage-ledger emission into one transaction in `recordSteps`.
 * - UsageLedgerServiceModule → `IUsageLedgerService` for the 
 *   usage-ledger emission hook in `recordSteps` (injected @Optional so unit
 *   fixtures can still construct the service without it).
 *
 * Exports both the symbol token (for `@Inject(IAgentTrajectoryService)`) and the
 * concrete class so emitter modules (live-doc, summary) can wire it directly.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, UsageLedgerServiceModule],
  providers: [
    AgentTrajectoryService,
    {
      provide: IAgentTrajectoryService,
      // useExisting, not useClass — useClass would construct a second
      // AgentTrajectoryService instance instead of aliasing the one above.
      // `TRAJECTORY_CHANNEL_PREFIX` is a readonly constant, not mutable
      // state, and it publishes to Redis per-call rather than holding a
      // subscription, so the duplicate was harmless, but aliasing is free.
      useExisting: AgentTrajectoryService,
    },
  ],
  exports: [IAgentTrajectoryService, AgentTrajectoryService],
})
export class AgentTrajectoryServiceModule {}
