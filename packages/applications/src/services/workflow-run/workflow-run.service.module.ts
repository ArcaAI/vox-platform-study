import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { AgentTrajectoryServiceModule } from '../agent-trajectory';
import { HarnessGatewayServiceModule } from '../consultation/harness/harness-gateway.service.module';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { WorkflowRunService } from './workflow-run.service';
import { WorkflowRunResultRetentionService } from './workflow-run-result-retention.service';
import { IWorkflowRunService } from './IWorkflowRunService';
import { WorkflowRunTraceAccessService } from './run-trace-access';
import { RunPrincipalAccessService } from './run-principal-access';

/**
 * WorkflowRunService DI module.
 *
 * - CommonServiceModule → config + globals.
 * - CoreDatabaseModule → `WorkflowRunRepository`.
 * - AgentTrajectoryServiceModule → `IAgentTrajectoryService`, reused by
 *   `getRunTrace` for the single bounded step read (README Task 5 — PHI/
 *   `payloadRef` handling stays in one place).
 * - HarnessGatewayServiceModule → the outbound harness client, for the LIVE gate read/approve
 * The gate's state is not in the read model by design — see
 *   `IWorkflowRunService.getRunGate`.
 *
 * Exports both the symbol token (for `@Inject(IWorkflowRunService)`) and the
 * concrete class.
 *
 * TASK-1038 (OD-25) — also hosts the daily result purge (`WorkflowRunResultRetentionService`,
 * `workflowRuns.resultRetentionDays`), with a local `TenantSettingsService` for its per-tenant
 * window (the usage-ledger module's pattern).
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, AgentTrajectoryServiceModule, HarnessGatewayServiceModule],
  providers: [
    WorkflowRunService,
    TenantSettingsService,
    WorkflowRunResultRetentionService,
    // TASK-1038 B3a — the admin trace's audience check.
    WorkflowRunTraceAccessService,
    // TASK-1038 OD-35 — business-plane run reads bound to the starting principal (workflow + agent runs).
    RunPrincipalAccessService,
    {
      provide: IWorkflowRunService,
      // useExisting, not useClass — useClass would construct a second
      // WorkflowRunService instance instead of aliasing the one above.
      useExisting: WorkflowRunService,
    },
  ],
  exports: [IWorkflowRunService, WorkflowRunService, WorkflowRunTraceAccessService, RunPrincipalAccessService],
})
export class WorkflowRunServiceModule {}
