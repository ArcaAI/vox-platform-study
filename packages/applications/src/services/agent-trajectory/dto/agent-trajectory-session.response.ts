import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * a distinct working session (grouped by
 * `sessionKind + sessionId + runId`) with its step count and first/last
 * timestamps, for the admin session list.
 */
export class AgentTrajectorySessionResponse {
  @ApiProperty()
  sessionId: string;

  @ApiProperty({ description: 'Empty-string sentinel for non-Temporal sessions.' })
  runId: string;

  @ApiProperty({ description: 'LIVE_DOC | HARNESS_DOC | SUMMARY_JOB | EVAL_RUN.' })
  sessionKind: string;

  @ApiPropertyOptional({ nullable: true })
  consultationId: string | null;

  @ApiProperty({ description: 'Number of steps in the session.' })
  stepCount: number;

  @ApiProperty({ description: 'Earliest step start (ISO-8601).' })
  firstStepAt: string;

  @ApiProperty({ description: 'Latest step end/start (ISO-8601).' })
  lastStepAt: string;
}

/** A page of distinct sessions for a tenant. */
export class AgentTrajectorySessionsListResponse {
  @ApiProperty({ type: [AgentTrajectorySessionResponse] })
  items: AgentTrajectorySessionResponse[];

  @ApiProperty({ description: 'Total distinct sessions matching the filters.' })
  total: number;
}
