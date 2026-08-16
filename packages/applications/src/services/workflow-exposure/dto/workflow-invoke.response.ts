import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * `202 Accepted` body of `POST /api/v1/workflows/:slug/invoke` — mirrors
 * SMR's streaming-202 shape (`generate.py:405-411`, cited in the ticket
 * README Task 6). `streamUrl` is a relative gateway path; the caller mints
 * its own single-use stream ticket via `POST /api/v1/auth/stream-ticket`
 * (scope `workflow_run:<runId>`) before opening it — this response never
 * carries a ticket or a JWT (S-6).
 */
export class WorkflowInvokeResponse {
  @ApiProperty({ description: 'The domain run id.' })
  runId: string;

  @ApiProperty({ description: '"started" for a fresh run, "already_running" when Idempotency-Key/workflow-id collision returned the SAME run.' })
  status: 'started' | 'already_running';

  @ApiProperty({ description: 'Relative path — GET/stream this to poll or watch progress.' })
  statusUrl: string;

  @ApiProperty({ description: 'Relative path — open with a minted stream ticket for SSE progress.' })
  streamUrl: string;
}

/** One stage entry as reported by the interpreter's `state` query — shape is interpreter-owned. */
export class WorkflowRunStageResponse {
  [key: string]: unknown;
}

/**
 * Response of `GET /api/v1/workflows/:slug/runs/:runId` — the LIVE status
 * (queried from the harness dispatcher's `GET /workflow-runs/{runId}`, which
 * reads Temporal `describe()` + the workflow's own `state` query) merged
 * with the read-model row's slug/version identity for the URL to stay
 * meaningful.
 */
export class WorkflowRunStatusResponse {
  @ApiProperty()
  runId: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  workflowVersionNumber: number;

  @ApiProperty({ description: 'Live Temporal-sourced status string (RUNNING/COMPLETED/FAILED/CANCELED/TIMED_OUT/…).' })
  status: string;

  @ApiProperty({ type: [WorkflowRunStageResponse] })
  stages: Record<string, unknown>[];

  @ApiPropertyOptional({ nullable: true })
  startedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  endedAt: string | null;
}

/** Response of `POST /api/v1/workflows/:slug/runs/:runId/cancel`. */
export class WorkflowRunCancelResponse {
  @ApiProperty()
  runId: string;

  @ApiProperty({ description: '"cancel_requested" — the signal was sent; cancellation is not necessarily complete yet.' })
  status: string;
}
