import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { GUARDRAIL_DIRECTIONS, GUARDRAIL_JUDGE_LANES } from '@arcaai/types';

/** Inline sample text cap. Sample text is synthetic platform-admin input, never a consultation. */
export const GUARDRAIL_DRY_RUN_MAX_TEXT_CHARS = 20_000;
/** Guardrail's own per-call sample cap (`JudgeDryRunRequest.samples`, max_length 50). */
export const GUARDRAIL_DRY_RUN_MAX_SAMPLES = 50;
export const GUARDRAIL_DRY_RUN_MODES = ['prompt', 'response'] as const;

/** A draft native mapping (`_metadata.judge` editable half), layered over each lane model's stored declaration. */
export class GuardrailDryRunJudgeMetaDraft {
  @ApiPropertyOptional({ description: 'Native category → `{ lane, category }`.' })
  @IsOptional()
  @IsObject()
  categoryMap?: Record<string, { lane: string; category: string }>;

  @ApiPropertyOptional({ description: '`{ Safe, Controversial, Unsafe }` tier mapping.' })
  @IsOptional()
  @IsObject()
  tiers?: Record<string, string>;
}

/**
 * `POST admin/guardrail/dry-run` — run DRAFT judge configuration on samples against the LIVE judge (README §11.3 B).
 * Persists nothing, loads nothing: a lane whose model is not resident is 409 `MODEL_NOT_RESIDENT` (OD-35).
 * Forwarded to guardrail `POST /api/v1/guardrail/judge/dry-run` (lane W2a1).
 */
export class GuardrailDryRunRequest {
  @ApiProperty({ enum: GUARDRAIL_JUDGE_LANES, isArray: true, description: 'The lanes to judge the samples on.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(GUARDRAIL_JUDGE_LANES.length)
  @ArrayUnique()
  @IsIn(GUARDRAIL_JUDGE_LANES as unknown as string[], { each: true })
  lanes!: string[];

  @ApiProperty({ enum: GUARDRAIL_DIRECTIONS, description: 'Which side of a generation the samples stand for.' })
  @IsIn(GUARDRAIL_DIRECTIONS as unknown as string[])
  direction!: string;

  @ApiPropertyOptional({
    enum: GUARDRAIL_DRY_RUN_MODES,
    description: 'Native judges only: prompt (user turn) or response moderation. Default `prompt`.',
  })
  @IsOptional()
  @IsIn(GUARDRAIL_DRY_RUN_MODES as unknown as string[])
  mode?: string;

  @ApiPropertyOptional({ description: 'The user turn, for a response-mode native judge.', maxLength: GUARDRAIL_DRY_RUN_MAX_TEXT_CHARS })
  @IsOptional()
  @IsString()
  @MaxLength(GUARDRAIL_DRY_RUN_MAX_TEXT_CHARS)
  promptContext?: string;

  @ApiProperty({
    type: [String],
    description: `1–${GUARDRAIL_DRY_RUN_MAX_SAMPLES} sample texts (synthetic, or a curated evaluation sample pasted in).`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(GUARDRAIL_DRY_RUN_MAX_SAMPLES)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(GUARDRAIL_DRY_RUN_MAX_TEXT_CHARS, { each: true })
  samples!: string[];

  @ApiPropertyOptional({
    description:
      'DRAFT policy values keyed by policy key: any criteria key, `judgeTemperature`, `judgeMaxTokens`. Each is validated exactly as a save would be (bounds, judge template); nothing is stored.',
    example: { judgeTemperature: 0 },
  })
  @IsOptional()
  @IsObject()
  policy?: Record<string, unknown>;

  @ApiPropertyOptional({ type: GuardrailDryRunJudgeMetaDraft, description: 'A draft native mapping (qwen3guard_native lanes).' })
  @IsOptional()
  @ValidateNested()
  @Type(() => GuardrailDryRunJudgeMetaDraft)
  judgeMeta?: GuardrailDryRunJudgeMetaDraft;
}

export class GuardrailDryRunLaneModel {
  @ApiProperty({ enum: GUARDRAIL_JUDGE_LANES }) lane!: string;
  @ApiProperty({ nullable: true, type: String }) modelId!: string | null;
  @ApiProperty({ nullable: true, type: String }) modelSlug!: string | null;
}

export class GuardrailDryRunVerdict {
  @ApiProperty({ enum: GUARDRAIL_JUDGE_LANES }) lane!: string;
  @ApiProperty({ description: '`pass` | `flag` | `undetermined`. Anything guardrail did not state reads `undetermined`.' }) verdict!: string;
  @ApiProperty({ nullable: true, type: String }) category!: string | null;
  @ApiProperty({ nullable: true, type: Number }) confidence!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'The model slug that answered.' }) model!: string | null;
  @ApiProperty({ nullable: true, type: Number }) latencyMs!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'Native tier (`Safe` | `Controversial` | `Unsafe`) for a qwen3guard_native judge.' })
  tier!: string | null;
}

export class GuardrailDryRunSampleResult {
  @ApiProperty() sampleIndex!: number;
  @ApiProperty({ nullable: true, type: Number }) latencyMs!: number | null;
  @ApiProperty({ type: [GuardrailDryRunVerdict], description: 'One per requested lane, in request order.' }) verdicts!: GuardrailDryRunVerdict[];
}

export class GuardrailDryRunResponse {
  @ApiProperty({ type: [GuardrailDryRunLaneModel], description: 'The model each lane ran on (the current selection).' })
  models!: GuardrailDryRunLaneModel[];

  @ApiProperty({ type: [GuardrailDryRunSampleResult] })
  results!: GuardrailDryRunSampleResult[];

  @ApiProperty({ nullable: true, type: Number, description: 'Whole call, as guardrail measured it.' })
  latencyMs!: number | null;

  @ApiProperty({ description: 'Always false: a dry run stores nothing.', example: false })
  persisted!: false;
}
