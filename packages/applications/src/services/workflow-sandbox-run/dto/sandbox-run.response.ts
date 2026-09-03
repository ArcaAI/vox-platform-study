import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * `202 Accepted` body of `POST .../sandbox-runs` — mirrors `WorkflowInvokeResponse`'s shape
 * definitionId-keyed instead of slug-keyed since a sandbox run may target a DRAFT
 * version that has no public slug-invocable surface at all.
 */
export class SandboxRunResponse {
  @ApiProperty({ description: 'The domain run id.' })
  runId: string;

  @ApiProperty({ description: '"started" for a fresh run, "already_running" on a workflow-id collision.' })
  status: 'started' | 'already_running';

  @ApiProperty({ description: 'Relative path — GET this to poll status.' })
  statusUrl: string;

  @ApiProperty({ description: 'Relative path — open with a minted stream ticket (scope `workflow_run:<runId>`) for SSE progress.' })
  streamUrl: string;
}

/** One stage entry as reported by the interpreter's `state` query — shape is interpreter-owned. */
export class SandboxRunStageResponse {
  [key: string]: unknown;
}

/** Response of `GET .../sandbox-runs/:runId` — the LIVE status, same source as the exposure plane's read. */
export class SandboxRunStatusResponse {
  @ApiProperty()
  runId: string;

  @ApiProperty()
  workflowDefinitionId: string;

  @ApiProperty({ description: 'Live Temporal-sourced status string (RUNNING/COMPLETED/FAILED/CANCELED/TIMED_OUT/…).' })
  status: string;

  @ApiProperty({ type: [SandboxRunStageResponse] })
  stages: Record<string, unknown>[];

  @ApiPropertyOptional({ nullable: true })
  startedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  endedAt: string | null;
}

/** Response of `POST .../sandbox-runs/:runId/cancel`. */
export class SandboxRunCancelResponse {
  @ApiProperty()
  runId: string;

  @ApiProperty({ description: '"cancel_requested" — the signal was sent; cancellation is not necessarily complete yet.' })
  status: string;
}
