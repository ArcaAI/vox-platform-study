import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One workflow-substrate run, projected for the runs list / detail read APIs
 * Denormalized read model — `workflowSlug` / `workflowVersionNumber`
 * / `definitionName` render without a join even after the definition is
 * renamed or superseded (see workflow-run.prisma header, R7).
 */
export class WorkflowRunResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ description: 'WorkflowDefinition.id of the exact PUBLISHED, immutable version row pinned for this run.' })
  workflowVersionId: string;

  @ApiProperty({ description: 'WorkflowDefinition.slug — the stable lineage key across versions.' })
  workflowSlug: string;

  @ApiProperty()
  workflowVersionNumber: number;

  @ApiProperty({ description: 'Denormalized WorkflowDefinition.name at run time.' })
  definitionName: string;

  @ApiProperty({ description: 'The AgentTrajectoryStep join key ("workflow-interpreter-{runId}").' })
  sessionId: string;

  @ApiProperty({ description: 'The domain run id (empty-string sentinel convention).' })
  runId: string;

  @ApiProperty({ description: 'consultation open | api invoke | webhook | schedule.' })
  trigger: string;

  @ApiProperty({ description: 'RUNNING | COMPLETED | FAILED | CANCELED | TIMED_OUT. No DEGRADED value — see degradedNodeCount.' })
  status: string;

  @ApiProperty()
  isSandbox: boolean;

  @ApiProperty({ description: 'Run start (ISO-8601).' })
  startedAt: string;

  @ApiPropertyOptional({ nullable: true, description: 'Run end (ISO-8601), null while RUNNING.' })
  endedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  durationMs: number | null;

  @ApiPropertyOptional({ nullable: true })
  nodeCount: number | null;

  @ApiProperty()
  failedNodeCount: number;

  @ApiProperty({ description: 'Count of nodes that degraded (produced a marked nothing) — a flag, never a run status.' })
  degradedNodeCount: number;

  @ApiPropertyOptional({
    nullable: true,
    description: "Count of nodes SKIPPED for cause. Sourced from the row's `_metadata.skippedNodeCount` — there is no dedicated column.",
  })
  skippedNodeCount: number | null;

  @ApiProperty({
    description: 'True when the run COMPLETED with at least one degraded-or-skipped-for-cause node. A derived flag, never a run status.',
  })
  degraded: boolean;

  @ApiPropertyOptional({ nullable: true })
  firstErrorCode: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      "The run's delivered output, from its `output.deliver` node. Either `{ resultRef: { bucket, key, sizeBytes } }` — a claim-check pointer to fetch out of band — or `{ outputs: { ... } }` inline for a small payload. Null while the run is in flight, and for any graph with no `output.deliver` node.",
  })
  resultRef: Record<string, unknown> | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "TASK-950 — the clinician this run acts FOR, read back from the row's `_metadata.actingUserId`. Recorded only for a STANDALONE machine-triggered run whose trigger schema declares a user-identity field; it sits BESIDE the actor the audit envelope already names (the service account), never instead of it. `null` for a human caller (the caller already IS the clinician), for a consultation-bound run (identity is `Consultation.doctorId`), and for a schema that declares no identity field — three different reasons, one honest absence.",
  })
  actingUserId?: string | null;

  @ApiProperty({ description: 'Row creation instant (ISO-8601).' })
  createdAt: string;
}

/** A keyset page of runs (ordered by `startedAt desc`) — matches the client `CursorPaginated<T>`. */
export class WorkflowRunsPageResponse {
  @ApiProperty({ type: [WorkflowRunResponse] })
  items: WorkflowRunResponse[];

  @ApiPropertyOptional({ nullable: true, description: 'Opaque cursor for the next page, or null at the end.' })
  nextCursor: string | null;

  @ApiProperty()
  hasMore: boolean;

  @ApiProperty()
  limit: number;
}
