import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JsonValue } from '@arcaai/domains';

/** One eval run (TASK-330 Phase 6 — read projection of `EvalRun`). */
export class EvalRunResponse {
  @ApiProperty({ description: 'Eval run id.' })
  id: string;

  @ApiProperty({ description: 'Owning tenant id.' })
  tenantId: string;

  @ApiProperty({ description: 'Golden set the run scored against.' })
  goldenSetId: string;

  @ApiProperty({ description: 'Model under evaluation.' })
  modelName: string;

  @ApiPropertyOptional({ description: 'Model version (null when unset).', nullable: true })
  modelVersion: string | null;

  @ApiPropertyOptional({ description: 'Prompt template id (null when unset).', nullable: true })
  promptTemplateId: string | null;

  @ApiPropertyOptional({ description: 'Prompt version (null when unset).', nullable: true })
  promptVersion: string | null;

  @ApiPropertyOptional({ description: 'Judge model id (null when unset).', nullable: true })
  judgeModel: string | null;

  @ApiPropertyOptional({ description: 'Run status (e.g. RUNNING/COMPLETED/FAILED; null when unset).', nullable: true })
  status: string | null;

  @ApiPropertyOptional({ description: 'Run start timestamp (ISO-8601; null when unset).', nullable: true })
  startedAt: string | null;

  @ApiPropertyOptional({ description: 'Run completion timestamp (ISO-8601; null when unset).', nullable: true })
  completedAt: string | null;

  @ApiPropertyOptional({ description: 'Aggregate metric scores (free-form JSON; null when unset).', nullable: true })
  aggregateScores: JsonValue | null;

  @ApiPropertyOptional({ description: 'Free-text notes (null when unset).', nullable: true })
  notes: string | null;

  @ApiProperty({ description: 'Created timestamp (ISO-8601).' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp (ISO-8601).' })
  updatedAt: string;
}

/** One per-case metric score within an eval run (read projection of `EvalScore`). */
export class EvalScoreResponse {
  @ApiProperty({ description: 'Eval score id.' })
  id: string;

  @ApiProperty({ description: 'Owning tenant id.' })
  tenantId: string;

  @ApiProperty({ description: 'Parent eval run id.' })
  evalRunId: string;

  @ApiProperty({ description: 'Golden case scored.' })
  goldenCaseId: string;

  @ApiProperty({ description: 'Metric name.' })
  metric: string;

  @ApiProperty({ description: 'Score value.' })
  score: number;

  @ApiPropertyOptional({ description: 'Maximum possible score for the metric (null when unbounded).', nullable: true })
  maxScore: number | null;

  @ApiPropertyOptional({ description: 'Judge rationale (null when unset).', nullable: true })
  rationale: string | null;

  @ApiPropertyOptional({ description: 'Judge model id (null when unset).', nullable: true })
  judgeModel: string | null;

  @ApiPropertyOptional({ description: 'Additional metric detail (free-form JSON; null when unset).', nullable: true })
  details: JsonValue | null;

  @ApiProperty({ description: 'Created timestamp (ISO-8601).' })
  createdAt: string;
}

/** An eval run with its per-case scores (the `GET eval-runs/:id` detail view). */
export class EvalRunDetailResponse extends EvalRunResponse {
  @ApiProperty({ type: [EvalScoreResponse], description: 'Per-case metric scores for this run.' })
  scores: EvalScoreResponse[];
}

/** Paginated eval-run listing. */
export class EvalRunListResponse {
  @ApiProperty({ type: [EvalRunResponse] })
  items: EvalRunResponse[];

  @ApiProperty({ description: 'Total runs matching the filter (across all pages).', example: 12 })
  total: number;
}
