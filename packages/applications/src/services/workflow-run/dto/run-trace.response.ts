import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WorkflowRunResponse } from './workflow-run.response';

/**
 * One node-execution rollup within a run's trace (TASK-723 Task 5's
 * `getRunTrace`).
 *
 * `nodeType` is the trajectory step's `name` (`= payload.node_type` on the
 * interpreter side) — NOT a per-node id. The Task 1 contract (§5,
 * `contracts/run-read-model.contract.md`) found that TASK-718 does not stamp
 * a `node_id` onto the persisted trajectory row, only onto the ephemeral
 * in-workflow `NodeResult`, so two distinct node INSTANCES of the same TYPE
 * within one run are indistinguishable in the trajectory stream except by
 * `order` (their position in the run's `seq` sequence). `order` is therefore
 * the closest thing to node identity this rollup can offer today.
 *
 * `attemptGroupingIsDerived` is ALWAYS `true` (Task 1 contract §3: no attempt
 * column exists anywhere) — a consecutive run of steps sharing the same
 * `nodeType` at increasing `seq` is folded into one group and labelled as a
 * DERIVED retry grouping, never presented as authoritative (README pitfall 4).
 *
 * `degraded` cannot be told apart from a critically-FAILED node using the
 * trajectory row alone (Task 1 contract §5 — both persist as
 * `status: ERROR`); this rollup does not attempt that distinction from the
 * trajectory alone. `WorkflowRun.degradedNodeCount`/`failedNodeCount` (set by
 * `recordRunFinished`, once TASK-718 is wired to call it) are the
 * authoritative run-level counts. A per-node ERROR status here is rendered
 * honestly as "error" without asserting degraded vs. failed.
 */
export class RunNodeRollupResponse {
  @ApiProperty({ description: 'The trajectory step name (node TYPE) — see class doc: not a per-node id.' })
  nodeType: string;

  @ApiProperty({ description: "0-based position of this node group in the run's step order." })
  order: number;

  @ApiProperty({ description: "The LAST attempt's AgentStepStatus: STARTED | OK | ERROR | SKIPPED | TIMEOUT." })
  status: string;

  @ApiProperty({ description: "First attempt's start (ISO-8601)." })
  startedAt: string;

  @ApiPropertyOptional({ nullable: true, description: "Last attempt's end (ISO-8601), null while in-flight." })
  endedAt: string | null;

  @ApiPropertyOptional({ nullable: true, description: "Last attempt's duration." })
  durationMs: number | null;

  @ApiPropertyOptional({ nullable: true })
  errorCode: string | null;

  @ApiProperty({ type: [Number], description: 'The trajectory `seq` values folded into this group, in attempt order.' })
  attemptSeqs: number[];

  @ApiProperty()
  attemptCount: number;

  @ApiProperty({ description: 'Always true today — see class doc. Render this grouping as DERIVED, never authoritative.' })
  attemptGroupingIsDerived: boolean;
}

/**
 * The CQRS-lite read shape for a run's trace: the run row plus its per-node
 * rollup, assembled from ONE bounded trajectory read (no per-node query — see
 * README acceptance criteria).
 */
export class RunTraceResponse {
  @ApiProperty({ type: WorkflowRunResponse })
  run: WorkflowRunResponse;

  @ApiProperty({ type: [RunNodeRollupResponse] })
  nodes: RunNodeRollupResponse[];

  @ApiProperty({ description: 'Total trajectory steps folded into `nodes` (before grouping).' })
  stepCount: number;

  @ApiProperty({ description: 'True when the bounded trajectory read hit its cap (R8) — the rollup is a prefix, not the whole run.' })
  truncated: boolean;

  @ApiProperty({
    description:
      'True when the run row exists but its trace has zero steps AND startedAt predates the effective trajectory-retention window (Task 9 "trace pruned" state) — never render an empty timeline silently.',
  })
  tracePruned: boolean;
}
