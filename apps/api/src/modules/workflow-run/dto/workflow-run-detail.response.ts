import { WorkflowRunResponse } from '@arcaai/applications';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The run DETAIL shape: the run row plus the one figure that does not live on
 * it (TASK-959 §3.4).
 *
 * WHY IT EXTENDS RATHER THAN REPLACES. `WorkflowRunResponse` is the projection
 * of a `WorkflowRun` row and is shared with the LIST route, where a per-run
 * ledger sum would be one query per row. `cpuSeconds` is not a property of the
 * run at all — it is a sum over `AiUsageEvent` keyed on the run id, produced by
 * the harness worker's metering interceptor and delivered through the usage
 * outbox, so it arrives minutes after the run finished and belongs to the
 * billing plane rather than the run read model. Adding it to the shared
 * projection would put a metering read on the list path to serve the detail
 * path; extending it here keeps the cost where the figure is asked for.
 */
export class WorkflowRunDetailResponse extends WorkflowRunResponse {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      "Σ CPU_SECOND under capability WORKFLOW for this run — the durable worker's own CPU, fair-share apportioned across concurrently executing activities (§3.4, D-5). NULL, not 0, when the run has no such rows: a run that predates the metering interceptor and a run that burned no measurable CPU are different facts. Orchestration CPU (the sandboxed workflow bodies and their replay) and the SDK's Rust core are deliberately NOT in this number — they are reconciled monthly against the pod's own CPU.",
  })
  cpuSeconds!: number | null;
}
