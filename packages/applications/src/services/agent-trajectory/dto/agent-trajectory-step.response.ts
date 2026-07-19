import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JsonValue } from '@arcaai/domains';

/**
 * TASK-510 Phase 2B — one ordered trajectory step projected for read APIs and
 * the live-view Redis republish. `payloadRef` is DELIBERATELY not exposed: it
 * is a claim-check / encrypted pointer to session working data (`@Secret` on
 * the entity), so it never leaves the service in a projection.
 */
export class AgentTrajectoryStepResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiPropertyOptional({ nullable: true })
  consultationId: string | null;

  @ApiProperty({ description: 'LIVE_DOC | HARNESS_DOC | SUMMARY_JOB | EVAL_RUN.' })
  sessionKind: string;

  @ApiProperty()
  sessionId: string;

  @ApiProperty({ description: 'Empty-string sentinel for non-Temporal sessions.' })
  runId: string;

  @ApiProperty({ description: 'Per-(sessionId, runId) monotonic sequence.' })
  seq: number;

  @ApiProperty({ description: 'LLM_CALL | TOOL_CALL | SENSOR | RETRIEVAL | GUARDRAIL | THINKING | SIGNAL | GATE | PHASE.' })
  stepType: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: 'STARTED | OK | ERROR | SKIPPED | TIMEOUT.' })
  status: string;

  @ApiProperty({ description: 'Step start (ISO-8601).' })
  startedAt: string;

  @ApiPropertyOptional({ nullable: true, description: 'Step end (ISO-8601), null while in-flight.' })
  endedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  durationMs: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'AD-1 GenerationStats on LLM_CALL steps.' })
  stats: JsonValue | null;

  @ApiPropertyOptional({ nullable: true })
  errorCode: string | null;

  @ApiPropertyOptional({ nullable: true })
  correlationId: string | null;

  @ApiProperty({ description: 'Row creation instant (ISO-8601).' })
  createdAt: string;
}

/** A keyset page of steps (ordered by `seq asc`) — matches the client `PageResult`. */
export class AgentTrajectoryStepsPageResponse {
  @ApiProperty({ type: [AgentTrajectoryStepResponse] })
  items: AgentTrajectoryStepResponse[];

  @ApiPropertyOptional({ nullable: true, description: 'Opaque cursor for the next page, or null at the end.' })
  nextCursor: string | null;

  @ApiProperty()
  hasMore: boolean;

  @ApiProperty()
  limit: number;
}
