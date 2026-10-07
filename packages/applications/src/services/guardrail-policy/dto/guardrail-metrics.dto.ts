import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { GUARDRAIL_CHECK_IDS, GUARDRAIL_DECISIONS, GUARDRAIL_DIRECTIONS } from '@arcaai/types';

/** Bucket widths the activity series may be cut into. */
export const GUARDRAIL_METRICS_BUCKETS = ['5m', '1h', '1d'] as const;
export type GuardrailMetricsBucket = (typeof GUARDRAIL_METRICS_BUCKETS)[number];

export class GuardrailMetricsWindowQuery {
  @ApiPropertyOptional({ description: 'ISO-8601 start (inclusive). Default: 24 h before `to`.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 end (exclusive). Default: now.' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ enum: GUARDRAIL_METRICS_BUCKETS, description: 'Series bucket width. Default `1h`.' })
  @IsOptional()
  @IsIn(GUARDRAIL_METRICS_BUCKETS as unknown as string[])
  bucket?: GuardrailMetricsBucket;

  @ApiPropertyOptional({ description: 'Narrow to one tenant. Absent = every tenant (platform view).' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}

export class GuardrailMetricsEvaluationListQuery extends GuardrailMetricsWindowQuery {
  @ApiPropertyOptional({ enum: GUARDRAIL_DECISIONS })
  @IsOptional()
  @IsIn(GUARDRAIL_DECISIONS as unknown as string[])
  decision?: string;

  @ApiPropertyOptional({ enum: GUARDRAIL_DIRECTIONS })
  @IsOptional()
  @IsIn(GUARDRAIL_DIRECTIONS as unknown as string[])
  direction?: string;

  @ApiPropertyOptional({ enum: GUARDRAIL_CHECK_IDS, description: 'Only evaluations that ran this check.' })
  @IsOptional()
  @IsIn(GUARDRAIL_CHECK_IDS as unknown as string[])
  checkId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  consultationId?: string;

  @ApiPropertyOptional({ description: 'Opaque keyset cursor from a previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class GuardrailActivityTotalsResponse {
  @ApiProperty() evaluations!: number;
  @ApiProperty() allow!: number;
  @ApiProperty() warn!: number;
  @ApiProperty() block!: number;
  @ApiProperty() unverified!: number;
  @ApiProperty({ description: '(warn + block) / evaluations; 0 when there are none.' }) flagRate!: number;
  @ApiProperty({ description: 'Notices resolved `acknowledged` in the window (SAFETY_OVERRIDE).' }) overrides!: number;
}

export class GuardrailActivitySeriesPoint {
  @ApiProperty() bucketStart!: string;
  @ApiProperty({ enum: GUARDRAIL_DIRECTIONS }) direction!: string;
  @ApiProperty({ enum: GUARDRAIL_DECISIONS }) decision!: string;
  @ApiProperty() count!: number;
}

export class GuardrailActivityCheckCount {
  @ApiProperty() checkId!: string;
  @ApiProperty({ enum: GUARDRAIL_DIRECTIONS }) direction!: string;
  @ApiProperty() verdict!: string;
  @ApiProperty() actionTaken!: string;
  @ApiProperty() count!: number;
}

export class GuardrailActivityCategoryCount {
  @ApiProperty() checkId!: string;
  @ApiProperty() category!: string;
  @ApiProperty() count!: number;
}

export class GuardrailActivityTenantRow {
  @ApiProperty() tenantId!: string;
  @ApiProperty() evaluations!: number;
  @ApiProperty() warn!: number;
  @ApiProperty() block!: number;
  @ApiProperty() unverified!: number;
}

export class GuardrailActivityModelRow {
  @ApiProperty() model!: string;
  @ApiProperty() checkId!: string;
  @ApiProperty() calls!: number;
  @ApiProperty() flags!: number;
  @ApiProperty() undetermined!: number;
  @ApiProperty({ nullable: true, type: Number }) avgLatencyMs!: number | null;
}

export class GuardrailActivityResponse {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ enum: GUARDRAIL_METRICS_BUCKETS }) bucket!: string;
  @ApiProperty({ nullable: true, type: String }) tenantId!: string | null;
  @ApiProperty({ type: GuardrailActivityTotalsResponse }) totals!: GuardrailActivityTotalsResponse;
  @ApiProperty({ type: [GuardrailActivitySeriesPoint] }) series!: GuardrailActivitySeriesPoint[];
  @ApiProperty({ type: [GuardrailActivityCheckCount] }) checks!: GuardrailActivityCheckCount[];
  @ApiProperty({ type: [GuardrailActivityCategoryCount] }) topCategories!: GuardrailActivityCategoryCount[];
  @ApiProperty({ type: [GuardrailActivityTenantRow] }) perTenant!: GuardrailActivityTenantRow[];
  @ApiProperty({ type: [GuardrailActivityModelRow] }) perModel!: GuardrailActivityModelRow[];
}

/** One labelled Prometheus value. */
export class GuardrailMetricSample {
  @ApiProperty({ description: 'The series labels that identify it (task, model, gate, peer, …).' }) labels!: Record<string, string>;
  @ApiProperty() value!: number;
}

export class GuardrailPerformanceResponse {
  @ApiProperty() at!: string;
  @ApiProperty({ description: 'False when Prometheus answered nothing at all (every series below then empty / null).' }) available!: boolean;
  @ApiProperty({ type: [GuardrailMetricSample], description: 'p50 screen-window latency (s) per task.' }) windowLatencyP50!: GuardrailMetricSample[];
  @ApiProperty({ type: [GuardrailMetricSample], description: 'p95 screen-window latency (s) per task.' }) windowLatencyP95!: GuardrailMetricSample[];
  @ApiProperty({ type: [GuardrailMetricSample], description: 'p50 inference latency (s) per guardrail model.' })
  modelLatencyP50!: GuardrailMetricSample[];
  @ApiProperty({ type: [GuardrailMetricSample], description: 'p95 inference latency (s) per guardrail model.' })
  modelLatencyP95!: GuardrailMetricSample[];
  @ApiProperty({ nullable: true, type: Number, description: 'Medical-judge verdicts per second (5 m rate).' }) judgeCallsPerSecond!: number | null;
  @ApiProperty({
    type: [GuardrailMetricSample],
    description: 'Delegated peer calls per second (the judge lanes ride text / nlp), per peer and operation.',
  })
  peerCallsPerSecond!: GuardrailMetricSample[];
  @ApiProperty({ type: [GuardrailMetricSample] }) queueDepth!: GuardrailMetricSample[];
  @ApiProperty({ type: [GuardrailMetricSample], description: 'Admission rejections per second, per gate.' })
  admissionRejectionsPerSecond!: GuardrailMetricSample[];
  @ApiProperty({ type: [GuardrailMetricSample], description: '0 closed, 1 half-open, 2 open, per peer.' }) circuitBreakers!: GuardrailMetricSample[];
  @ApiProperty({ type: [GuardrailMetricSample], description: 'Peer failures per second, per peer and reason.' })
  peerFailuresPerSecond!: GuardrailMetricSample[];
  @ApiProperty({ type: [GuardrailMetricSample] }) windowCacheHitRatio!: GuardrailMetricSample[];
  @ApiProperty({ nullable: true, type: Number, description: '`guardrail_evaluation_missing_total` (the reconciler gauge).' }) evaluationsMissing!:
    number | null;
  @ApiProperty({ type: [GuardrailMetricSample], description: 'Every `guardrail_evaluation_outbox_*` series (label `__name__` names it).' })
  outbox!: GuardrailMetricSample[];
}

export class GuardrailHealthModelRow {
  @ApiProperty() taskKey!: string;
  @ApiProperty({ nullable: true, type: String }) lane!: string | null;
  @ApiProperty({ nullable: true, type: String }) modelId!: string | null;
  @ApiProperty({ nullable: true, type: String }) slug!: string | null;
  @ApiProperty({ description: '`loaded` | `loading` | `unloading` | `not_loaded` | `unknown`. Read-only (→ /model-residency).' }) residency!: string;
}

export class GuardrailHealthResponse {
  @ApiProperty() at!: string;
  @ApiProperty({ type: [GuardrailHealthModelRow] }) models!: GuardrailHealthModelRow[];
  @ApiProperty({ nullable: true, type: Number, description: 'Share of checks `undetermined` over the last hour; `null` with no checks.' })
  undeterminedRate!: number | null;
  @ApiProperty({ nullable: true, type: String }) lastEvaluationAt!: string | null;
  @ApiProperty({ nullable: true, type: Number }) secondsSinceLastEvaluation!: number | null;
}

/** One evaluation row for the drill-down. No content: the `checks` array carries none by contract. */
export class GuardrailEvaluationListItem {
  @ApiProperty() id!: string;
  @ApiProperty() tenantId!: string;
  @ApiProperty() at!: string;
  @ApiProperty({ enum: GUARDRAIL_DIRECTIONS }) direction!: string;
  @ApiProperty({ enum: GUARDRAIL_DECISIONS }) decision!: string;
  @ApiProperty() caller!: string;
  @ApiProperty({ nullable: true, type: String }) consultationId!: string | null;
  @ApiProperty({ nullable: true, type: String }) runId!: string | null;
  @ApiProperty({ nullable: true, type: String }) nodeId!: string | null;
  @ApiProperty({ nullable: true, type: String }) agentSlug!: string | null;
  @ApiProperty({ nullable: true, type: String }) exempt!: string | null;
  @ApiProperty() policyVersion!: string;
  @ApiProperty({ type: [String] }) noticeIds!: string[];
  @ApiProperty({ description: 'Per-check results (verdict, score, category, action, model, latency, region keys) — never text.' }) checks!: unknown[];
  @ApiProperty({ description: 'An outbound block withheld output (readable only via the admin review route).' }) hasWithheldContent!: boolean;
}

export class GuardrailEvaluationListResponse {
  @ApiProperty({ type: [GuardrailEvaluationListItem] }) items!: GuardrailEvaluationListItem[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}
